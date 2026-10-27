/**
 * #7686: an opt-in refresh publishes a diverged managed checkout before it
 * fast-forwards.
 *
 * Protects: with `sources.refresh_publish_diverged` on (standing consent, default
 * off) a refresh of a checkout that has local commits while its upstream moved
 * on pushes HEAD merged with the upstream in memory (the keep-checkout publish,
 * which never moves the checkout), then fast-forwards, keeping the local commits;
 * with the setting off it refuses `refresh_diverged` as before; a conflicting path
 * refuses `integrate_conflict` naming the path and changes nothing; a dry run never
 * publishes.
 * Regression it catches: a refresh that pushes local commits without the
 * setting, one that moves the checkout or drops the local commits while
 * publishing, and one that pushes or fences anything when the merge conflicts.
 * Seams: none; a real bare remote, a pushing clone and the managed checkout.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { REFRESH_PUBLISH_DIVERGED_KEY, refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

const each = async (fn: (f: RefreshFixture) => Promise<void>) => {
  for (const engine of engines) {
    await withRefreshFixture(engine, async f => {
      try { await fn(f); } finally { await engine.unsetConfig(REFRESH_PUBLISH_DIVERGED_KEY); }
    });
  }
};
const refusedWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, e => e as { code?: string; message?: string; suggestion?: string; detail?: string });
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};
const remoteHead = (f: RefreshFixture) => git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
/** The upstream moves on while the managed checkout gains a local commit: a diverged checkout. */
function diverge(f: RefreshFixture, local = { path: 'beta/local.md', content: page('Local', 'A local commit nobody pushed.') }): string {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(f.root, local.path), local.content);
  git(f.root, 'add', local.path); git(f.root, 'commit', '-qm', 'local only');
  return f.head();
}

test('the setting is a registered knob, default off', () => {
  expect(REFRESH_PUBLISH_DIVERGED_KEY).toBe('sources.refresh_publish_diverged');
  expect(KNOWN_CONFIG_KEYS).toContain(REFRESH_PUBLISH_DIVERGED_KEY);
  expect(KNOWN_CONFIG_KEYS).toEqual(expect.arrayContaining(['sources.refresh_fetch_timeout_ms', 'sources.refresh_drain_wait_ms']));
});

test('setting on: a diverged refresh publishes the local commits merged with the upstream, then fast-forwards and keeps them', () => each(async f => {
  const local = diverge(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const done = await refreshWorktree(f.engine, f.alpha);
  expect(done).toMatchObject({ status: 'completed', old_head: local, published: { local_commits: 1, integrated: 1 } });
  expect(done.published!.sha).toBe(remoteHead(f));
  expect(done.target_head).toBe(done.published!.sha);
  expect(f.head()).toBe(done.published!.sha);
  git(f.root, 'merge-base', '--is-ancestor', local, 'HEAD');
  expect(readFileSync(join(f.root, 'alpha/two.md'), 'utf8')).toContain('Upstream side.');
  expect(readFileSync(join(f.root, 'beta/local.md'), 'utf8')).toContain('A local commit nobody pushed.');
  expect(await f.lastCommit(f.alpha)).toBe(done.published!.sha);
  expect(await f.lastCommit(f.beta)).toBe(done.published!.sha);
}), 120_000);

test('setting on: the text result names the publish', () => each(async f => {
  diverge(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'on');
  const out: string[] = [];
  const log = console.log;
  _resetCliExitVerdictForTests();
  console.log = (line: string) => { out.push(line); };
  try { await runSourcesRefresh(f.engine, [f.alpha]); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }
  expect(out.join('\n')).toContain('Published 1 local commit(s) merged with 1 upstream commit(s) as ');
  expect(out.join('\n')).toContain('Refresh completed');
}), 120_000);

test('setting off (unset or false): the refresh refuses refresh_diverged, pushes nothing and names the setting', () => each(async f => {
  const local = diverge(f);
  const remote = remoteHead(f);
  for (const value of [null, 'false']) {
    if (value !== null) await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, value);
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged');
    expect(error.suggestion).toContain('gbrain config set sources.refresh_publish_diverged true');
    expect(remoteHead(f)).toBe(remote);
    expect(f.head()).toBe(local);
    expect(await f.refreshRows()).toEqual([]);
  }
}), 120_000);

test('setting on: a conflicting path refuses integrate_conflict naming it, and nothing is pushed, fenced or moved', () => each(async f => {
  const local = diverge(f, { path: 'alpha/two.md', content: page('Alpha two', 'Local side.') });
  const remote = remoteHead(f);
  const lastAlpha = await f.lastCommit(f.alpha);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'integrate_conflict') as { detail?: string; suggestion?: string };
  expect(JSON.parse(error.detail!).paths).toEqual(['alpha/two.md']);
  expect(error.suggestion).toContain('--keep-checkout');
  expect(error.suggestion).toContain('--resolve alpha/two.md=ours|theirs');
  expect(remoteHead(f)).toBe(remote);
  expect(f.head()).toBe(local);
  expect(readFileSync(join(f.root, 'alpha/two.md'), 'utf8')).toContain('Local side.');
  expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  expect(await f.refreshRows()).toEqual([]);
  expect(await f.lastCommit(f.alpha)).toBe(lastAlpha);
}), 120_000);

test('setting on: a dry run publishes nothing and still refuses refresh_diverged', () => each(async f => {
  const local = diverge(f);
  const remote = remoteHead(f);
  await f.engine.setConfig(REFRESH_PUBLISH_DIVERGED_KEY, 'true');
  await refusedWith(refreshWorktree(f.engine, f.alpha, { dryRun: true }), 'refresh_diverged');
  expect(remoteHead(f)).toBe(remote);
  expect(f.head()).toBe(local);
}), 120_000);
