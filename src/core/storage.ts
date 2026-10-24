import { closeSync, openSync, readSync, statSync, type Stats } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';

/**
 * StorageBackend — pluggable interface for binary file storage.
 *
 * GBrain is agnostic about where files live. The setup skill picks
 * the backend (Supabase Storage or S3/R2/MinIO), gbrain doesn't care.
 */

export interface StorageBackend {
  upload(path: string, data: Buffer, mime?: string): Promise<void>;
  /** Upload a file from disk with memory bounded independently of its size (#7427). */
  uploadFile(path: string, filePath: string, mime?: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  getUrl(path: string): Promise<string>;
}

export interface StorageConfig {
  backend: 's3' | 'supabase' | 'local';
  bucket: string;
  region?: string;
  endpoint?: string;
  // S3 credentials
  accessKeyId?: string;
  secretAccessKey?: string;
  // Supabase credentials
  projectUrl?: string;
  serviceRoleKey?: string;
  // Local (for testing)
  localPath?: string;
}

/**
 * Create a StorageBackend from config.
 */
export async function createStorage(config: StorageConfig): Promise<StorageBackend> {
  switch (config.backend) {
    case 's3': {
      const { S3Storage } = await import('./storage/s3.ts');
      return new S3Storage(config);
    }
    case 'supabase': {
      const { SupabaseStorage } = await import('./storage/supabase.ts');
      return new SupabaseStorage(config);
    }
    case 'local': {
      const { LocalStorage } = await import('./storage/local.ts');
      return new LocalStorage(config.localPath || '/tmp/gbrain-storage');
    }
    default:
      throw new Error(`Unknown storage backend: ${config.backend}`);
  }
}

/** SHA-256 of a file read in fixed-size chunks, so large originals are never held in memory. */
export function hashStorageFile(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let length: number;
    while ((length = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, length));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/**
 * Upload a file whose hash the caller already computed, then refuse when the file changed since `before` was taken,
 * so a row is never recorded under a hash the stored bytes may not match.
 */
export async function uploadUnchangedFile(storage: StorageBackend, path: string, filePath: string, before: Stats, mime?: string): Promise<void> {
  await storage.uploadFile(path, filePath, mime);
  const after = statSync(filePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`${filePath} changed during the upload, so its hash may not match the stored bytes; nothing was recorded. Upload it again once it stops changing.`);
  }
}

/** Read exactly `length` bytes at `position` into the start of `buffer`. */
export async function readFileRange(file: FileHandle, buffer: Buffer, length: number, position: number): Promise<Buffer> {
  for (let filled = 0; filled < length;) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) throw new Error('File shrank during upload');
    filled += bytesRead;
  }
  return buffer.subarray(0, length);
}
