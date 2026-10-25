/**
 * G6 (git-canonical memory): inbox-folder captures on a strict (canonical: git) managed source are door-only.
 *
 * The inbox-folder source (ingestion/sources/inbox-folder.ts) writes no page itself: it emits one IngestionEvent per
 * dropped file, which the ingestion daemon submits as an ingest_capture job (minions/handlers/ingest-capture.ts). That
 * handler is the writer, so this drives both: three files dropped in the inbox, each event handed to the handler the
 * way the job worker runs it. After the batch every captured page is at HEAD with the bytes on disk, the tree is clean,
 * the git-gap census reports no gap, and the batch makes at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-ingestion-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { createInboxFolderSource } from '../src/core/ingestion/sources/inbox-folder.ts';
import { IngestionTestHarness } from '../src/core/ingestion/test-harness.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

/** A chokidar stand-in: `ready` fires on start, `add` when the test drops a file. */
function stubWatcher() {
  const emitter = new EventEmitter();
  const watcher = { on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return watcher; },
    once: (event: string, fn: (...args: unknown[]) => void) => { if (event === 'ready') queueMicrotask(() => fn()); else emitter.once(event, fn); return watcher; },
    close: async () => { emitter.removeAllListeners(); } } as unknown as FSWatcher;
  return { watcher, add: (path: string) => emitter.emit('add', path) };
}

const job = (data: Record<string, unknown>): MinionJobContext => ({ id: 1, name: 'ingest_capture', data, attempts_made: 1, signal: new AbortController().signal,
  deadlineAtMs: null, shutdownSignal: new AbortController().signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
  isActive: async () => true, readInbox: async () => [] });

const drops: Record<string, string> = {
  'alice-example.md': '---\ntitle: Alice example capture\n---\n\nMet alice-example about the acme-example launch.\n',
  'acme-example.md': '---\ntitle: Acme example capture\n---\n\nAcme example quarterly notes.\n',
  'bob-example.md': '---\ntitle: Bob example capture\n---\n\nBob example follow-up.\n',
};

for (const backend of testBackends()) describe(`[${backend}] G6: inbox-folder captures on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('three dropped files: every captured page at HEAD, clean tree, no census gap, one commit per group', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const inbox = mkdtempSync(join(tmpdir(), 'gbrain-g6-inbox-'));
    try {
      const stub = stubWatcher();
      const harness = new IngestionTestHarness();
      await harness.run(createInboxFolderSource({ inboxDir: inbox, debounceMs: 10, _watchFactory: () => stub.watcher }));
      mkdirSync(inbox, { recursive: true });
      for (const [name, body] of Object.entries(drops)) { writeFileSync(join(inbox, name), body); stub.add(join(inbox, name)); }
      for (let i = 0; i < 200 && harness.events.length < 3; i++) await Bun.sleep(10);
      await harness.stop();
      expect(harness.events).toHaveLength(3);
      const base = head(root);
      const handler = makeIngestCaptureHandler(engine);
      const slugs = Object.keys(drops).map(name => `inbox/${name.replace(/\.md$/, '')}`);
      const results = await Promise.allSettled(harness.events.map(event => handler(job({ event, slug: `inbox/${String(event.metadata?.original_filename).replace(/\.md$/, '')}` }))));
      console.log(`[G6 ingest-capture/${backend}] results=${JSON.stringify(results.map(r => r.status === 'fulfilled' ? r.value.status : (r.reason as { code?: string }).code ?? String(r.reason)))}`);
      const m = await measureBatch(engine, 'default', root, base, slugs);
      console.log(describeMeasure(`ingest-capture/${backend}`, m));
      expect(results.map(r => r.status)).toEqual(slugs.map(() => 'fulfilled'));
      expectDoorOnly(m, expect);
    } finally { rmSync(inbox, { recursive: true, force: true }); }
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);
});
