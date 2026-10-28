/**
 * #7866: a conversion's strict passes on a production-shaped source. On master a no-change `sources canonical --to git`
 * re-imported every page its `--full` episode found not derived-current (pages written before contextual retrieval had
 * no mode stamp), queued an embedding effect for each, did it again in the second pass, and stopped
 * `git_conversion_incomplete` whenever one of its own writes outlived the single pass's 5 s wait. These tests pin the
 * fixed behaviour: a full round without an episode, no embedding effect for a no-op whose chunks hold their vectors, a
 * drained pass, progress whose total is the planned paths, and refusals that carry the operator contract.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { applyGitConversion, planGitConversion, type ConversionProgress } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { operationsByName } from '../src/core/operations.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { acquireCommitLockAsync } from '../src/core/git/commit-push.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const N = 30;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (i: number, body = `Committed body ${i}.`) => `---\ntype: concept\ntitle: note ${i}\n---\n\n${body}\n`;
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < N; i++) writeFileSync(join(root, `notes/n${String(i).padStart(2, '0')}.md`), note(i));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};
/** Pages as an older gbrain left them: every chunk embedded for its text, and no contextual-mode stamp. */
async function legacyEmbedded(engine: BrainEngine): Promise<void> {
  const [col] = await engine.executeRaw<{ t: string }>("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  const dims = Number(col!.t.match(/\d+/)![0]);
  await engine.executeRaw(`UPDATE content_chunks SET embedding=('[' || array_to_string(array_fill(0.1::real, ARRAY[${dims}]), ',') || ']')::vector, embedded_at=now(), embedded_text_hash=md5(chunk_text)`);
  await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL');
}
const counts = async (engine: BrainEngine) => {
  const [row] = await engine.executeRaw<{ embedding: number; imports: number }>(`SELECT (SELECT count(*)::int FROM persistence_effects WHERE kind='embedding') AS embedding,
    (SELECT count(*)::int FROM persistence_requests WHERE intent->>'kind'='managed_sync_import') AS imports`);
  return row!;
};
async function firstSync(engine: BrainEngine): Promise<void> {
  expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noExtract: true })).status).toBe('first_sync');
}
async function convert(engine: BrainEngine, seen: ConversionProgress[] = []) {
  const { preview } = await planGitConversion(engine, 'default');
  expect(preview.discard.count).toBe(0);
  return applyGitConversion(engine, 'default', preview.preview_hash, { noExtract: true, onProgress: progress => seen.push(progress) });
}
const strictEvents = (seen: ConversionProgress[]) => seen.filter(progress => progress.phase.startsWith('strict_pass'));

for (const backend of testBackends()) describe(`[${backend}] #7866: the conversion's strict passes`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a no-change conversion of pages an older gbrain embedded makes no embedding effect and no write', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    await legacyEmbedded(engine);
    const before = await counts(engine);
    const seen: ConversionProgress[] = [];
    expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    expect(await counts(engine)).toEqual(before);
    // Progress: the total is the planned paths in both passes and never changes within them.
    expect(strictEvents(seen).length).toBeGreaterThan(0);
    expect(strictEvents(seen).every(progress => progress.total === N)).toBe(true);
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(1);
  }, { databaseUrl, setup }), 300_000);

  test('a no-op re-import queues no embedding effect when every chunk holds a vector for its text, and still queues one for a page whose vector is for other text', () => managedBrain(async ({ engine }) => {
    await firstSync(engine);
    await legacyEmbedded(engine);
    // A parser this binary no longer records owes every page a re-import; the re-import changes no content.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,parser}', '"parser-of-an-older-release"'::jsonb) WHERE completed_keys->0 ? 'parser'`);
    const [unembedded] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/n07'");
    await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash=md5('text an earlier revision held') WHERE page_id=$1", [unembedded!.id]);
    const before = await counts(engine);
    const [{ last }] = await engine.executeRaw<{ last: string }>('SELECT COALESCE(max(id), 0)::text AS last FROM persistence_effects') as [{ last: string }];
    expect(await convert(engine)).toMatchObject({ status: 'converted' });
    const after = await counts(engine);
    expect(after.imports - before.imports).toBe(N);
    const queued = await engine.executeRaw<{ page_id: number }>("SELECT (data->>'page_id')::int AS page_id FROM persistence_effects WHERE kind='embedding' AND id > $1::bigint", [last]);
    expect(queued.map(row => Number(row.page_id))).toEqual([Number(unembedded!.id)]);
  }, { databaseUrl, setup }), 300_000);

  test('a strict pass whose own write outlives the single pass\'s receipt wait drains on instead of refusing writer_pending', () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    writeFileSync(join(root, 'notes/n03.md'), note(3, 'Edited in Git after the last sync.'));
    git(root, 'commit', '-qam', 'edit n03');
    const seen: ConversionProgress[] = [];
    let stalled = false;
    // Once the strict pass froze its import, the consumer stops claiming for 33 s: the admitted request waits queued past
    // the single pass's receipt wait (5 s, held to 30 s while queued here), as it does behind a busy owner on a production host.
    let armed = false;
    installFaultHook(async point => {
      if (point === 'sync:after_freeze' && seen.at(-1)?.phase === 'strict_pass_1') armed = true;
      if (point !== 'consumer:claiming' || !armed || stalled) return;
      stalled = true;
      await Bun.sleep(33_000);
    });
    try {
      expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    } finally { installFaultHook(undefined); }
    expect(stalled).toBe(true);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/n03'");
    expect(page!.compiled_truth).toContain('Edited in Git after the last sync.');
    // The round names its candidate and its one import batch; the total stays the planned paths.
    const pass1 = seen.filter(progress => progress.phase === 'strict_pass_1');
    expect(pass1.every(progress => progress.total === N)).toBe(true);
    expect(pass1.some(progress => progress.round === 1 && progress.candidates === 1 && progress.batch === 1 && progress.batches === 1)).toBe(true);
    expect(pass1.every(progress => progress.scanned <= (progress.candidates ?? 0))).toBe(true);
  }, { databaseUrl, setup }), 300_000);

  test('a concurrent drainer of the source refuses the apply with the operator contract and counts, before anything is flipped', () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    writeFileSync(join(root, 'notes/n05.md'), note(5, 'Edited in Git after the last sync.'));
    git(root, 'commit', '-qam', 'edit n05');
    const { preview } = await planGitConversion(engine, 'default');
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { acquired = resolve; });
    const holder = withDrainLease(engine, 'default', { holder: { kind: 'cli', id: null }, remote: false }, async () => { acquired(); await holding; return { status: 'up_to_date' } as SyncResult; });
    await held;
    const out: string[] = [];
    const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
    console.log = (line: unknown) => { out.push(String(line)); };
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-extract', '--json']); }
    finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; release(); await holder; }
    const refused = JSON.parse(out.at(-1)!);
    expect(refused).toMatchObject({ status: 'refused', code: 'git_conversion_incomplete',
      fix: { next: 'run', argv: ['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'], verify: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--json'] } },
      progress: { phase: 'strict_pass_1', total: N } });
    expect(refused.message).toContain('still mixed');
    // Nothing flipped, and the page Git moved still has the database's version for the next apply to take.
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(0);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/n05'");
    expect(page!.compiled_truth).toContain('Committed body 5.');
    // The same apply runs once the drainer is gone.
    const { preview: again } = await planGitConversion(engine, 'default');
    expect(await applyGitConversion(engine, 'default', again.preview_hash, { noExtract: true })).toMatchObject({ status: 'converted' });
  }, { databaseUrl, setup }), 300_000);

  test('the checkout\'s writer locks stay free while a strict pass holds the source\'s drain lease: they are taken per commit', () => managedBrain(async ({ engine, root }) => {
    await firstSync(engine);
    writeFileSync(join(root, 'notes/n04.md'), note(4, 'Edited in Git after the last sync.'));
    git(root, 'commit', '-qam', 'edit n04');
    const binding = (await getWorktreeBinding(engine, 'default'))!;
    const seen: ConversionProgress[] = [];
    const taken: string[] = [];
    installFaultHook(async point => {
      if (point !== 'sync:after_freeze' || taken.length || seen.at(-1)?.phase !== 'strict_pass_1') return;
      // A page write's publication takes the worktree writer lock; `gbrain git commit-push` takes the checkout's commit lock.
      const worktree = await acquireWorktree(binding, 0, undefined, engine, { yieldLanes: true });
      taken.push(worktree ? 'worktree' : 'worktree busy');
      await worktree?.release();
      const commit = await acquireCommitLockAsync(root, 0).then(lock => lock, () => null);
      taken.push(commit ? 'commit' : 'commit busy');
      await commit?.release();
    });
    try {
      expect(await convert(engine, seen)).toMatchObject({ status: 'converted' });
    } finally { installFaultHook(undefined); }
    expect(taken).toEqual(['worktree', 'commit']);
  }, { databaseUrl, setup }), 300_000);

  test('a repo-less brain is unaffected: pages write as before and the conversion refuses with the operator contract, writing nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repo-less-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
            logger: { info() {}, warn() {}, error() {} } } as Parameters<typeof operationsByName.put_page.handler>[0];
          await operationsByName.put_page.handler(ctx, { slug: 'notes/repo-less', content: note(1) });
          const out: string[] = [];
          const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
          console.log = (line: unknown) => { out.push(String(line)); };
          process.stderr.write = (() => true) as typeof process.stderr.write;
          try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', 'a'.repeat(64), '--no-extract', '--json']); }
          finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
          expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: 'refused', code: 'strict_requires_managed', fix: { verify: { argv: ['gbrain', 'doctor', '--json'] } } });
          expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(0);
          const [page] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='notes/repo-less'");
          expect(page!.compiled_truth).toContain('Committed body 1.');
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 300_000);
});
