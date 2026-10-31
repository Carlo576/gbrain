/**
 * GBRA-250: an untyped throw inside `gbrain sources refresh` (a statement error,
 * a TypeError) escaped runSourcesRefresh to the CLI fatal seam as a bare
 * internal_error with no stack and no refresh state, so a one-off failure left
 * nothing to diagnose. It is now a typed internal_error refusal whose `why`
 * carries the stack and whose fix names the refresh row it left, which the next
 * run resumes. A fence that waits past its lock timeout on a row another
 * transaction holds (Postgres 55P03, the reproduced shape of that failure) is
 * refresh_lock_timeout naming the open transactions instead.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { persistenceHome } from '../src/core/persistence/identity.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: BrainEngine;
let close: (() => Promise<void>) | undefined;
let databaseUrl = '';
beforeAll(async () => {
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engine = pg.engine; close = pg.close; databaseUrl = pg.databaseUrl; return; }
  engine = new PGLiteEngine();
  await (engine as PGLiteEngine).connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  if (close) await close(); else await (engine as PGLiteEngine).disconnect();
});

test('an untyped throw after the merge is a typed refusal with its stack, and the syncing row it leaves resumes', () => withRefreshFixture(engine, async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  const boom = new TypeError('member bookkeeping exploded');
  const failure = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'syncing') throw boom; } } }).then(() => null, error => error);
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure.code).toBe('internal_error');
  expect(failure.message).toContain('TypeError: member bookkeeping exploded');
  expect(failure.why).toContain(boom.stack!.split('\n')[1]!.trim());
  const [row] = await f.refreshRows();
  expect(row!.state).toBe('syncing');
  expect(failure.suggestion).toContain(`Refresh ${row!.id} stays syncing`);
  expect(f.head()).toBe(target);
  const resumed = await refreshWorktree(f.engine, f.alpha);
  expect(resumed.recovered?.refresh_id).toBe(row!.id);
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect((await f.refreshRows())[0]!.state).toBe('completed');
}), 120_000);

test('sources refresh prints an untyped throw as a refused document carrying the stack, and exits 1', async () => {
  const statement = Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
  const fake = { kind: 'postgres', getConfig: async () => { throw statement; }, executeRaw: async () => { throw statement; } } as unknown as BrainEngine;
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try {
    await withEnv({ GBRAIN_REFRESH_SYNC_BUDGET_MS: undefined }, () => runSourcesRefresh(fake, ['source-a', '--json']));
    expect(currentExitCode()).toBe(1);
  } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }
  expect(lines).toHaveLength(1);
  const doc = JSON.parse(lines[0]!);
  expect(doc.status).toBe('refused');
  expect(doc.code).toBe('internal_error');
  expect(doc.cause).toContain('Error (57014): canceling statement due to user request');
  expect(doc.why).toContain(statement.stack!.split('\n')[1]!.trim());
  expect(doc.fix).toContain('gbrain sources refresh source-a');
});

test('a database access error the classifier recognizes is rethrown unchanged, keeping its own repair fix', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  const fake = { kind: 'postgres', getConfig: async () => { throw refused; }, executeRaw: async () => { throw refused; } } as unknown as BrainEngine;
  const failure = await withEnv({ GBRAIN_REFRESH_SYNC_BUDGET_MS: undefined }, () => refreshWorktree(fake, 'source-a').then(() => null, error => error));
  expect(failure).toBe(refused);
});

test('an unexpected throw whose refresh row cannot be read says so, with credentials and the home directory redacted', async () => {
  const dsn = ['postgres', '://example:prefix)', 'SYNTHETIC', '_SECRET_SUFFIX@db.invalid/brain'].join('');
  const statement = Object.assign(new Error(`canceling statement due to user request near ${dsn}`), { code: '57014' });
  statement.stack = `Error: canceling statement\n    at fence (${homedir()}/brain-checkout/src/x.ts:1:1)\n    at ${dsn}`;
  const fake = { kind: 'postgres', getConfig: async () => { throw statement; }, executeRaw: async () => { throw statement; } } as unknown as BrainEngine;
  const failure = await withEnv({ GBRAIN_REFRESH_SYNC_BUDGET_MS: undefined }, () => refreshWorktree(fake, 'source-a').then(() => null, error => error));
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure.code).toBe('internal_error');
  expect(failure.suggestion).toContain('The refresh row could not be read');
  expect(failure.message).not.toContain('SYNTHETIC_SECRET_SUFFIX');
  expect(failure.why).not.toContain('SYNTHETIC_SECRET_SUFFIX');
  expect(failure.why).not.toContain(homedir());
  expect(failure.why).toContain('~/brain-checkout/src/x.ts');
});

test('an unexpected throw under --abandon repeats --abandon in its fix, never a plain refresh that would finish the refresh', async () => {
  const statement = Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
  const fake = { kind: 'postgres', getConfig: async () => { throw statement; }, executeRaw: async () => { throw statement; } } as unknown as BrainEngine;
  const failure = await withEnv({ GBRAIN_REFRESH_SYNC_BUDGET_MS: undefined }, () => refreshWorktree(fake, 'source-a', { abandon: true }).then(() => null, error => error));
  expect(failure.code).toBe('internal_error');
  expect(failure.suggestion).toContain('Run gbrain sources refresh source-a --abandon again');
});

test('a host identity file that cannot be read still yields a typed internal_error refusal', () => withRefreshFixture(engine, async f => {
  const hostFile = join(persistenceHome(), 'host.json');
  const original = readFileSync(hostFile, 'utf8');
  writeFileSync(hostFile, '{');
  let failure: unknown;
  try { failure = await refreshWorktree(f.engine, f.alpha).then(() => null, error => error); }
  finally { writeFileSync(hostFile, original); }
  expect(failure).toBeInstanceOf(OperationError);
  expect((failure as OperationError).code).toBe('internal_error');
  expect((failure as OperationError).message).toContain('SyntaxError');
  expect((failure as OperationError).suggestion).toContain('The refresh row could not be read');
}), 120_000);

/**
 * Another connection holds one source row until `release` (a stuck transaction on the brain host): `FOR UPDATE` by
 * default, or a plain read (AccessShareLock only, which cannot block the fence) with `plainRead`; with `refreshId` it also
 * holds that refresh row. Its last statement
 * carries a marker literal, which the refusal must never echo.
 */
async function holdSourceRow(sourceId: string, plainRead = false, refreshId?: string): Promise<{ pid: number; release: () => Promise<void> }> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let locked!: (pid: number) => void;
  const pid = new Promise<number>(resolve => { locked = resolve; });
  const tx = sql.begin(async t => {
    const [row] = plainRead
      ? await t`SELECT pg_backend_pid() AS pid FROM sources WHERE id=${sourceId}`
      : await t`SELECT pg_backend_pid() AS pid FROM sources WHERE id=${sourceId} FOR UPDATE`;
    if (refreshId) await t`SELECT id FROM persistence_worktree_refreshes WHERE id=${refreshId}::uuid FOR UPDATE`;
    await t.unsafe("SELECT 'holder-sql-marker' AS note");
    locked(Number(row!.pid));
    await released;
  });
  return { pid: await pid, release: async () => { release(); await tx; await sql.end(); } };
}

test.skipIf(!process.env.DATABASE_URL)('a source row held past the fence lock timeout is refresh_lock_timeout naming the holder, not internal_error', () => withRefreshFixture(engine, async f => {
  const before = f.head();
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  const held = await holdSourceRow(f.alpha);
  let failure: OperationError | null;
  const lines: string[] = [];
  try {
    failure = await refreshWorktree(f.engine, f.alpha).then(() => null, error => error);
    const log = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try { await runSourcesRefresh(f.engine, [f.alpha, '--json']); expect(currentExitCode()).toBe(1); }
    finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }
  } finally { await held.release(); }
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure!.code).toBe('refresh_lock_timeout');
  expect(failure!.why).toContain(`pid ${held.pid} `);
  const doc = JSON.parse(lines[0]!);
  expect(doc.status).toBe('refused');
  expect(doc.code).toBe('refresh_lock_timeout');
  expect(doc.why).toContain(`pid ${held.pid} `);
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(before);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(await f.lastCommit(f.alpha)).toBe(target);
}), 120_000);

test.skipIf(!process.env.DATABASE_URL)('a source row taken after the drain aborts the draining refresh as refresh_lock_timeout, and the next run completes', () => withRefreshFixture(engine, async f => {
  const before = f.head();
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  let held: Awaited<ReturnType<typeof holdSourceRow>> | undefined;
  const failure = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') held = await holdSourceRow(f.alpha); } } })
    .then(() => null, error => error).finally(() => held?.release());
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure.code).toBe('refresh_lock_timeout');
  expect(failure.why).toContain(`pid ${held!.pid} `);
  const [row] = await f.refreshRows();
  expect(failure.detail).toBe(`refresh_id=${row!.id}`);
  expect(row!.state).toBe('aborted');
  expect(f.head()).toBe(before);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(await f.lastCommit(f.alpha)).toBe(target);
}), 120_000);

test.skipIf(!process.env.DATABASE_URL)('the lock-timeout why names only row-lock holders in this database and never echoes their SQL', () => withRefreshFixture(engine, async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  const reader = await holdSourceRow(f.alpha, true);
  const held = await holdSourceRow(f.alpha);
  let failure: OperationError | null;
  try { failure = await refreshWorktree(f.engine, f.alpha).then(() => null, error => error); }
  finally { await held.release(); await reader.release(); }
  expect(failure!.code).toBe('refresh_lock_timeout');
  expect(failure!.why).toContain(`pid ${held.pid} `);
  expect(failure!.why).not.toContain(`pid ${reader.pid} `);
  expect(failure!.why).not.toContain('holder-sql-marker');
  expect(failure!.why).not.toContain('SELECT');
}), 120_000);

test.skipIf(!process.env.DATABASE_URL)('a lock timeout after the drain whose holder also holds the refresh row still refuses, leaving the row draining for the next run', () => withRefreshFixture(engine, async f => {
  const before = f.head();
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  let held: Awaited<ReturnType<typeof holdSourceRow>> | undefined;
  const failure = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async (point, row) => { if (point === 'drained') held = await holdSourceRow(f.alpha, false, row.id); } } })
    .then(() => null, error => error).finally(() => held?.release());
  expect(failure).toBeInstanceOf(OperationError);
  expect(failure.code).toBe('refresh_lock_timeout');
  const [row] = await f.refreshRows();
  expect(row!.state).toBe('draining');
  expect(f.head()).toBe(before);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(await f.lastCommit(f.alpha)).toBe(target);
}), 60_000);
