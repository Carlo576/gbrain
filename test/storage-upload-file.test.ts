/**
 * #7427 — uploading a large original must not read the whole file into memory.
 *
 * Every backend uploads straight from disk (StorageBackend.uploadFile):
 *   - S3 streams fixed-size multipart parts from one reused part buffer and
 *     aborts the multipart upload when a part fails;
 *   - Supabase TUS reads each 6 MiB chunk from disk;
 *   - local copies the file.
 * The callers (file_upload, gbrain files upload | upload-raw | sync | mirror)
 * hash and upload from the path, never via a whole-file read.
 *
 * The memory bound is asserted without allocating gigabytes: no request body
 * is larger than one part, and no body is a view into a larger allocation
 * (body.buffer.byteLength), which a whole-file buffer sliced into parts
 * would be.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, truncateSync, writeFileSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { S3Storage, multipartPartSize } from '../src/core/storage/s3.ts';
import { SupabaseStorage } from '../src/core/storage/supabase.ts';
import { LocalStorage } from '../src/core/storage/local.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runFiles } from '../src/commands/files.ts';
import { withEnv } from './helpers/with-env.ts';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const S3_PART = 16 * MiB;
const TUS_CHUNK = 6 * MiB;

let engine: PGLiteEngine;
let workDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  workDir = mkdtempSync(join(tmpdir(), 'gb-7427-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

function writePatterned(path: string, size: number): void {
  const fd = openSync(path, 'w');
  const block = Buffer.alloc(MiB);
  try {
    for (let offset = 0, i = 0; offset < size; offset += block.length, i++) {
      block.fill(i % 251);
      writeSync(fd, block, 0, Math.min(block.length, size - offset), offset);
    }
  } finally {
    closeSync(fd);
  }
}

function sha256Of(path: string): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const block = Buffer.alloc(MiB);
  try {
    let n: number;
    while ((n = readSync(fd, block, 0, block.length, null)) > 0) hash.update(block.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Records whole-file read APIs called on the given paths. */
function watchWholeFileReads(paths: string[]) {
  const targets = new Set(paths.map(p => resolve(p)));
  const spies = [spyOn(fs, 'readFileSync'), spyOn(fsp, 'readFile'), spyOn(Bun, 'file')];
  return {
    reads: () => spies.flatMap(s => s.mock.calls.map(c => c[0]))
      .filter(p => typeof p === 'string' && targets.has(resolve(p))),
    restore: () => spies.forEach(s => s.mockRestore()),
  };
}

function s3Stub(onSend: (command: any) => any): { client: S3Client; sent: any[] } {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      return onSend(command);
    },
  } as unknown as S3Client;
  return { client, sent };
}

describe('S3 uploadFile (#7427)', () => {
  test('a file larger than one part streams bounded multipart parts and completes in order', async () => {
    const src = join(workDir, 's3-large.bin');
    const size = 2 * S3_PART + MiB + 19;
    writePatterned(src, size);
    const received = createHash('sha256');
    const bodies: { length: number; allocation: number; contentLength: number }[] = [];
    const { client, sent } = s3Stub((command) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-a' };
      if (command instanceof UploadPartCommand) {
        const body = command.input.Body as Uint8Array;
        bodies.push({ length: body.byteLength, allocation: body.buffer.byteLength, contentLength: command.input.ContentLength! });
        received.update(body);
        return { ETag: '"etag-' + command.input.PartNumber + '"' };
      }
      return {};
    });
    const watch = watchWholeFileReads([src]);
    try {
      await new S3Storage({ backend: 's3', bucket: 'originals' }, client).uploadFile('media/s3-large.bin', src, 'video/mp4');
      expect(watch.reads()).toEqual([]);
    } finally {
      watch.restore();
    }

    expect(sent.some(c => c instanceof PutObjectCommand)).toBe(false);
    expect(sent[0]).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(sent[0].input).toEqual({ Bucket: 'originals', Key: 'media/s3-large.bin', ContentType: 'video/mp4' });
    expect(bodies.map(b => b.length)).toEqual([S3_PART, S3_PART, MiB + 19]);
    for (const b of bodies) {
      expect(b.allocation).toBeLessThanOrEqual(S3_PART);
      expect(b.contentLength).toBe(b.length);
    }
    expect(received.digest('hex')).toBe(sha256Of(src));
    const complete = sent.at(-1);
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(complete.input.UploadId).toBe('upload-a');
    expect(complete.input.MultipartUpload.Parts).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
      { PartNumber: 3, ETag: '"etag-3"' },
    ]);
  });

  test('a failed part aborts the multipart upload and surfaces the part error', async () => {
    const src = join(workDir, 's3-abort.bin');
    writePatterned(src, 2 * S3_PART + 7);
    const { client, sent } = s3Stub((command) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-b' };
      if (command instanceof UploadPartCommand && command.input.PartNumber === 2) throw new Error('part 2 rejected');
      if (command instanceof UploadPartCommand) return { ETag: '"e"' };
      if (command instanceof AbortMultipartUploadCommand) throw new Error('abort also failed');
      return {};
    });
    await expect(new S3Storage({ backend: 's3', bucket: 'originals' }, client).uploadFile('media/s3-abort.bin', src))
      .rejects.toThrow('part 2 rejected');
    const abort = sent.at(-1);
    expect(abort).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(abort.input).toEqual({ Bucket: 'originals', Key: 'media/s3-abort.bin', UploadId: 'upload-b' });
    expect(sent.some(c => c instanceof CompleteMultipartUploadCommand)).toBe(false);
    expect(sent.filter(c => c instanceof UploadPartCommand).length).toBe(2);
  });

  test('a file within one part is a single PutObject with the exact bytes', async () => {
    const src = join(workDir, 's3-small.txt');
    writeFileSync(src, 'small original');
    const { client, sent } = s3Stub(() => ({}));
    await new S3Storage({ backend: 's3', bucket: 'originals' }, client).uploadFile('notes/s3-small.txt', src, 'text/plain');
    expect(sent.length).toBe(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(Buffer.from(sent[0].input.Body).toString()).toBe('small original');
    expect(sent[0].input.ContentType).toBe('text/plain');
  });

  test('part size stays within S3 limits: >= 5 MiB, <= 5 GiB, at most 10,000 parts', () => {
    expect(multipartPartSize(33 * MiB)).toBe(S3_PART);
    for (const size of [22 * GiB, 1024 * GiB, 5 * 1024 * GiB, 10_000 * 5 * GiB]) {
      const part = multipartPartSize(size);
      expect(part).toBeGreaterThanOrEqual(5 * MiB);
      expect(part).toBeLessThanOrEqual(5 * GiB);
      expect(Math.ceil(size / part)).toBeLessThanOrEqual(10_000);
    }
    expect(() => multipartPartSize(10_000 * 5 * GiB + 1)).toThrow();
  });
});

describe('Supabase uploadFile (#7427)', () => {
  test('a TUS-sized file is sent in bounded chunks read from disk', async () => {
    const src = join(workDir, 'supabase-large.bin');
    const size = 100 * MiB + 3 * MiB + 5;
    writeFileSync(src, '');
    truncateSync(src, size);
    const fd = openSync(src, 'r+');
    for (let offset = 0, i = 1; offset < size; offset += 7 * MiB, i++) writeSync(fd, Buffer.alloc(4096, i), 0, 4096, offset);
    closeSync(fd);

    const received = createHash('sha256');
    const patches: { length: number; allocation: number }[] = [];
    let uploadLength = '';
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      if (init.method === 'POST') {
        uploadLength = headers['Upload-Length'];
        return new Response(null, { status: 201, headers: { Location: 'https://example.test/tus/1' } });
      }
      const body = init.body as Uint8Array;
      patches.push({ length: body.byteLength, allocation: body.buffer.byteLength });
      received.update(body);
      return new Response(null, { status: 204, headers: { 'Upload-Offset': String(Number(headers['Upload-Offset']) + body.byteLength) } });
    };
    const watch = watchWholeFileReads([src]);
    try {
      const storage = new SupabaseStorage({ backend: 'supabase', bucket: 'b', projectUrl: 'https://example.test', serviceRoleKey: 'k' }, fetchImpl);
      await storage.uploadFile('media/supabase-large.bin', src, 'video/mp4');
      expect(watch.reads()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(uploadLength).toBe(String(size));
    expect(patches.reduce((n, p) => n + p.length, 0)).toBe(size);
    for (const p of patches) {
      expect(p.length).toBeLessThanOrEqual(TUS_CHUNK);
      expect(p.allocation).toBeLessThanOrEqual(TUS_CHUNK);
    }
    expect(received.digest('hex')).toBe(sha256Of(src));
  });
});

describe('local uploadFile (#7427)', () => {
  test('copies the original without a whole-file read', async () => {
    const src = join(workDir, 'local-src.bin');
    writePatterned(src, 3 * MiB + 1);
    const storageDir = mkdtempSync(join(tmpdir(), 'gb-7427-local-'));
    const watch = watchWholeFileReads([src]);
    try {
      await new LocalStorage(storageDir).uploadFile('media/local-src.bin', src);
      expect(watch.reads()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(sha256Of(join(storageDir, 'media/local-src.bin'))).toBe(sha256Of(src));
    rmSync(storageDir, { recursive: true, force: true });
  });

  test('a stored object gets the mode a plain write gives, not the source file\'s mode', async () => {
    const src = join(workDir, 'local-private.bin');
    writePatterned(src, MiB + 5);
    fs.chmodSync(src, 0o600);
    const storageDir = mkdtempSync(join(tmpdir(), 'gb-7427-local-mode-'));
    const reference = join(storageDir, 'reference.bin');
    writeFileSync(reference, 'x');
    const storage = new LocalStorage(storageDir);
    await storage.uploadFile('media/new.bin', src);
    expect(fs.statSync(join(storageDir, 'media/new.bin')).mode & 0o777).toBe(fs.statSync(reference).mode & 0o777);
    fs.chmodSync(join(storageDir, 'media/new.bin'), 0o644);
    await storage.uploadFile('media/new.bin', src);
    expect(fs.statSync(join(storageDir, 'media/new.bin')).mode & 0o777).toBe(0o644);
    expect(sha256Of(join(storageDir, 'media/new.bin'))).toBe(sha256Of(src));
    rmSync(storageDir, { recursive: true, force: true });
  });
});

describe('upload callers hash and upload from disk (#7427)', () => {
  test('file_upload never reads the whole original', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'gb-7427-op-'));
    const src = join(workDir, 'op-original.mp4');
    writePatterned(src, 2 * MiB + 3);
    const ctx = {
      engine,
      config: { engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    } as never;
    const watch = watchWholeFileReads([src]);
    let out: { status: string; storage_path: string };
    try {
      out = await operationsByName['file_upload'].handler(ctx, { path: src, page_slug: 'media/op-example' }) as typeof out;
      expect(watch.reads()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(out.status).toBe('uploaded');
    expect(sha256Of(join(storageDir, out.storage_path))).toBe(sha256Of(src));
    const rows = await engine.executeRaw<{ content_hash: string }>(
      'SELECT content_hash FROM files WHERE storage_path = $1', [out.storage_path],
    );
    expect(rows[0].content_hash).toBe(sha256Of(src));
    rmSync(storageDir, { recursive: true, force: true });
  });

  test('a file that changes during the upload is refused and nothing is recorded', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'gb-7427-changed-'));
    const src = join(workDir, 'op-changing.mp4');
    writePatterned(src, MiB + 7);
    const ctx = {
      engine,
      config: { engine: 'pglite', storage: { backend: 'local', bucket: 'b', localPath: storageDir } },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    } as never;
    const original = LocalStorage.prototype.uploadFile;
    const spy = spyOn(LocalStorage.prototype, 'uploadFile').mockImplementation(async function (this: LocalStorage, path: string, filePath: string, mime?: string) {
      fs.appendFileSync(filePath, 'edited while uploading');
      return original.call(this, path, filePath, mime);
    });
    try {
      await expect(operationsByName['file_upload'].handler(ctx, { path: src, page_slug: 'media/changing-example' }))
        .rejects.toThrow(/changed during the upload/);
    } finally {
      spy.mockRestore();
    }
    const rows = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM files WHERE storage_path = 'media/changing-example/op-changing.mp4'");
    expect(Number(rows[0].n)).toBe(0);
    rmSync(storageDir, { recursive: true, force: true });
  });

  test('gbrain files upload, upload-raw, sync and mirror never read the whole original', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-7427-home-'));
    const storageDir = mkdtempSync(join(tmpdir(), 'gb-7427-cli-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'b', localPath: storageDir },
    }));
    const single = join(workDir, 'cli-single.mp4');
    writePatterned(single, MiB + 11);
    const syncDir = join(workDir, 'cli-sync');
    const mirrorDir = join(workDir, 'cli-mirror');
    mkdirSync(join(syncDir, 'media'), { recursive: true });
    mkdirSync(mirrorDir, { recursive: true });
    const synced = join(syncDir, 'media', 'clip.mp4');
    const mirrored = join(mirrorDir, 'clip.mp4');
    writePatterned(synced, MiB + 13);
    writePatterned(mirrored, MiB + 17);

    const watch = watchWholeFileReads([single, synced, mirrored]);
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await runFiles(engine, ['upload', single, '--page', 'media/cli-example']);
        await runFiles(engine, ['upload-raw', single, '--page', 'media/raw-example', '--no-pointer']);
        await runFiles(engine, ['sync', syncDir]);
        await runFiles(engine, ['mirror', mirrorDir]);
      });
      expect(watch.reads()).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(sha256Of(join(storageDir, 'media/cli-example/cli-single.mp4'))).toBe(sha256Of(single));
    expect(sha256Of(join(storageDir, 'media/raw-example/cli-single.mp4'))).toBe(sha256Of(single));
    expect(sha256Of(join(storageDir, 'media/clip.mp4'))).toBe(sha256Of(synced));
    expect(existsSync(join(storageDir, 'clip.mp4'))).toBe(true);
    expect(sha256Of(join(storageDir, 'clip.mp4'))).toBe(sha256Of(mirrored));
    rmSync(home, { recursive: true, force: true });
    rmSync(storageDir, { recursive: true, force: true });
  });
});
