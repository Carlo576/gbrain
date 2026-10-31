/**
 * #8072: a scheduled `gbrain sources refresh` tick on files over the 24 MiB page ceiling.
 *
 * 1. Protects: a Markdown file the streamed (segmented) preparation already read and refused is held `file_too_large`
 *    and stays held, unread, on later ticks while its bytes are unchanged: no new write request for it, no pass-2
 *    block read, the hold's attempt count unchanged. `gbrain sources retry-held` (and a gbrain upgrade) still
 *    re-screens it; a hold decided from the size alone keeps re-screening every sync (one lstat).
 *    The member syncs of one refresh are bounded by `sources.refresh_sync_budget_ms`: past it the refresh stays
 *    `syncing` and the next plain refresh finishes it.
 * 2. Fails when: every tick re-hashes and re-streams the unchanged held file (the hold re-screened on every sync), or a
 *    refresh tick keeps syncing past its budget under the refresh lock.
 * Counts, not wall-clock time: write requests, `streamedImportWork` bytes and the hold's attempts.
 * Repo-less brains have no managed sync or refresh (both need Git), so nothing here runs there.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { streamedImportWork } from '../src/core/page-body/streamed-import.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { holdRescreenDue, readGitSourceHolds, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { VERSION } from '../src/version.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const keyless = { OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GBRAIN_REFRESH_SYNC_BUDGET_MS: undefined };

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

const each = (fn: (f: RefreshFixture) => Promise<void>) => withEnv(keyless, async () => { for (const engine of engines) await withRefreshFixture(engine, fn); });
/** Over the page ceiling, under the segmented ceiling, with a facts fence the streamed import refuses after reading the whole file. */
const fenced = `${conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 8072 }).trimEnd()}\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Example fact | fact | 1.0 | world | high | | | test | |\n<!--- gbrain:facts:end -->\n`;

const holdsOf = async (f: RefreshFixture) => (await readGitSourceHolds(f.engine, { sourceIds: [f.alpha] }))[0]?.holds ?? [];
const requestsFor = async (f: RefreshFixture, slug: string) => Number((await f.engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2', [f.alpha, slug]))[0]!.n);

test('#8072: a held over-ceiling file the streamed import refused is not read again by later refresh ticks', () => each(async f => {
  await f.engine.setConfig('pages.segmented_storage', 'on');
  f.push('alpha/conv.md', fenced);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  const [held] = await holdsOf(f);
  expect(held).toMatchObject({ path: 'conv.md', code: 'file_too_large', meta: { attempts: 1 } });
  expect(held!.message).toContain('facts and takes fences');
  const requests = await requestsFor(f, 'conv');
  expect(requests).toBeGreaterThan(0);

  for (const tick of [1, 2]) {
    const target = f.push(`alpha/note-${tick}.md`, page(`Note ${tick}`, 'An unrelated edit that makes the tick sync.'));
    streamedImportWork.bytes = 0;
    expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
    expect(await f.lastCommit(f.alpha)).toBe(target);
    expect(await f.engine.getPage(`note-${tick}`, { sourceId: f.alpha })).not.toBeNull();
    expect(streamedImportWork.bytes).toBe(0);
    expect(await requestsFor(f, 'conv')).toBe(requests);
    expect(await holdsOf(f)).toMatchObject([{ path: 'conv.md', code: 'file_too_large', meta: { attempts: 1, blob_oid: held!.meta.blob_oid } }]);
  }

  // The explicit operator step still re-screens it (and holds it again: the same bytes are refused the same way).
  expect((await retryHeld(f.engine, f.alpha)).scheduled).toBe(1);
  f.push('alpha/note-3.md', page('Note 3', 'Another unrelated edit.'));
  streamedImportWork.bytes = 0;
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(streamedImportWork.bytes).toBeGreaterThan(0);
  expect(await requestsFor(f, 'conv')).toBe(requests + 1);
  expect(await holdsOf(f)).toMatchObject([{ path: 'conv.md', code: 'file_too_large', meta: { attempts: 2 } }]);
}), 600_000);

test('#8072: a streamed file_too_large hold re-screens on retry or another gbrain version; a size-only one on every sync', () => {
  const hold = (meta: Partial<GitHoldRecord['meta']>) => ({ code: 'file_too_large' as const, meta: { recovery_version: 99, blob_oid: 'a'.repeat(40), ...meta } as GitHoldRecord['meta'] });
  expect(holdRescreenDue(hold({ streamed: { gbrain_version: VERSION } }), false)).toBe(false);
  expect(holdRescreenDue(hold({ streamed: { gbrain_version: VERSION } }), true)).toBe(true);
  expect(holdRescreenDue(hold({ streamed: { gbrain_version: '0.0.1.0' } }), false)).toBe(true);
  expect(holdRescreenDue(hold({}), false)).toBe(true);
});

test('#8072: a refresh past its sync budget stays syncing and the next plain refresh finishes it', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  await f.engine.setConfig('sources.refresh_sync_budget_ms', '0');
  const deferred = await refreshWorktree(f.engine, f.alpha);
  expect(deferred).toMatchObject({ status: 'syncing', target_head: target, next: `gbrain sources refresh ${f.alpha} --resume` });
  expect(f.head()).toBe(target);
  expect(await f.lastCommit(f.alpha)).not.toBe(target);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['syncing']);

  await f.engine.setConfig('sources.refresh_sync_budget_ms', '600000');
  const finished = await refreshWorktree(f.engine, f.alpha);
  expect(finished.recovered).toMatchObject({ refresh_id: deferred.refresh_id, status: 'completed' });
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect(await f.lastCommit(f.beta)).toBe(target);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
}), 300_000);
