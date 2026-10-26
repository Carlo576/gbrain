/**
 * #7630: a relative stored sync anchor (a legacy `sources.local_path` of ".") must never make sync treat the directory
 * it runs from as the brain.
 *
 * Before the fix, `gbrain sync --source default` (or `--all`) run from an unrelated folder resolved "." to that folder,
 * `isAnchorOwnedSyncPath` compared realpath(".") with realpath(cwd) (always equal), and preflight Git-initialized the
 * folder, committed everything in it as a baseline and imported its markdown. A foreground write that ended
 * `preparation_stalled` meanwhile got a receipt telling the user to run exactly that sync.
 *
 * Protects:
 * - sync refuses `sync_anchor_relative` (exit 3, a fix asking the user for `gbrain sources set-path <id> <dir>`) for a relative
 *   `local_path` reached by `--source` (the anchor read) or by `--all` (the row's path passed through), and for a relative
 *   legacy `sync.repo_path`; the folder gets no `.git` and nothing is imported;
 * - a relative anchor never proves ownership, so even an explicit absolute path to the cwd is not auto-initialized;
 * - `gbrain sources set-path <id> --clear` clears a relative filesystem path without SQL, and still refuses an absolute one;
 * - doctor's `default_source_local_path` warns on a relative path, on any source, and `config set sync.repo_path` refuses one;
 * - no other reader resolves a relative root against the cwd: write-through, page and fact writes, capture origins,
 *   folder-to-source matching, fence repair, activation, import roots and freshness, remote submit_job, managed roots, and
 *   the dream, autopilot, per-phase and global maintenance cycles;
 * - a stalled foreground write's diagnosis inspects the writer and says to resubmit with a new request_id, while a
 *   recorded sync fault keeps its sync retry.
 *
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-refusal-7630-postgres.test.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { isAnchorOwnedSyncPath } from '../src/core/sync-anchor.ts';
import { clearConnectorLocalPath } from '../src/core/persistence/connector-path.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { classifyRecordedFault, classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { renderAction } from '../src/core/agent-output.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const SYNC = { noPull: true, noEmbed: true, noExtract: true, full: true };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#7630 [${backend}]: a relative stored anchor never makes the cwd the brain`, () => {
    let engine: BrainEngine, close: () => Promise<void>, home: string, folder: string, previousCwd: string;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-7630-home-'));
      folder = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-unrelated-')));
      writeFileSync(join(folder, 'notes.md'), '---\ntype: note\ntitle: Notes\n---\n\nA note that is not part of any brain.\n');
      writeFileSync(join(folder, 'private.txt'), 'not for any brain\n');
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      previousCwd = process.cwd();
      process.chdir(folder);
    }, 120_000);

    afterEach(async () => {
      process.chdir(previousCwd);
      await close();
      rmSync(folder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    const pageCount = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n;
    const sync = async (opts: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, async () => {
      const { performSync } = await import('../src/commands/sync.ts');
      return performSync(engine, { ...SYNC, ...opts }).then(() => null, (error: unknown) => error as { code?: string; fix?: { argv?: string[]; ask_user?: boolean } });
    });
    const cli = async (run: () => Promise<unknown>) => {
      const lines: string[] = [];
      let exit: number | undefined;
      const push = (...a: unknown[]) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
      const spies = [spyOn(console, 'log').mockImplementation(push), spyOn(console, 'error').mockImplementation(push),
        spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never),
        spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code; throw new Error(`__exit__${code}`); }) as never)];
      try {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, run);
      } catch (error) {
        if (!String(error).includes('__exit__')) throw error;
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return { lines, exit };
    };
    const pagesOf = async (sourceId: string) =>
      (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [sourceId]))[0]!.n;

    test('--source default with local_path "." refuses sync_anchor_relative: no .git, no commit, no import', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const before = await pageCount();
      const refused = await sync({ sourceId: 'default' });
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(refused?.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'default', '<dir>']);
      expect(refused?.fix?.ask_user).toBe(true);
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pageCount()).toBe(before);
    }, 120_000);

    test('--all passes the row\'s "." through as repoPath: refused the same way', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const refused = await sync({ sourceId: 'default', repoPath: '.' });
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    // Value: protects=gbrain sync --all fails only the source with a relative local_path and still syncs an absolute one;
    //   fails_when=the --all fan-out guard aborts the whole run, drops the source, or reports it ok / imports the cwd;
    //   why_new=the performSync cases above never enter runSyncAll's fan-out or its per-source JSON envelope; seam=none;
    //   no_claim=the cost-gate walk ordering (--no-embed skips the gate), the exit-3 mapping of a single-source run, and parallel
    //   import workers (--workers 1: a worker opens the configured DATABASE_URL, not this test's isolated Postgres database)
    test('gbrain sync --all fails only the relative source: an absolute source still syncs and the cwd is untouched', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-repo-')));
      try {
        execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
        writeFileSync(join(repo, 'kept.md'), '---\ntype: note\ntitle: Kept\n---\n\nA page of the absolute source.\n');
        execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        const before = await pagesOf('default');
        const { lines, exit } = await cli(async () => {
          const { runSync } = await import('../src/commands/sync.ts');
          await runSync(engine, ['--all', '--no-pull', '--no-embed', '--json', '--workers', '1']);
        });
        const envelope = JSON.parse(lines.find(line => line.startsWith('{"schema_version"'))!) as { sources: Array<{ source_id: string; status: string; error?: string }>; error_count: number };
        const bySource = Object.fromEntries(envelope.sources.map(s => [s.source_id, s]));
        expect(bySource.default?.status).toBe('error');
        expect(bySource.default?.error).toContain('relative local_path');
        expect(bySource['notes-a']?.status).not.toBe('error');
        expect(envelope.error_count).toBe(1);
        expect(exit).toBe(1);
        expect(existsSync(join(folder, '.git'))).toBe(false);
        expect(await pagesOf('default')).toBe(before);
        expect(await pagesOf('notes-a')).toBe(1);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    const runSyncCli = async (args: string[]) => {
      let refused: { code?: string } | undefined;
      const result = await cli(async () => {
        const { runSync } = await import('../src/commands/sync.ts');
        await runSync(engine, args).catch((error: { code?: string }) => {
          if (String(error).includes('__exit__')) throw error;
          refused = error;
        });
      });
      return { ...result, refused };
    };

    // Value: protects=gbrain sync --source with a relative anchor refuses before the embed cost gate estimates the cwd or calls a provider;
    //   fails_when=the runSingleSourceSync guard is removed or moved after the cost gate, which then walks and prices the cwd's files;
    //   why_new=every other refusal case uses performSync or --no-embed, which skips the gate; seam=none;
    //   no_claim=a real provider (dummy key via configureGateway; fetch is watched, never answered)
    test('gbrain sync --source default refuses a relative anchor before the embed cost gate: no estimate, no provider call', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      for (let i = 0; i < 5; i++) writeFileSync(join(folder, `page-${i}.md`), `---\ntype: note\ntitle: Page ${i}\n---\n\n${'word '.repeat(200)}\n`);
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-7630' } });
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('#7630 test: no provider call'); }) as never);
      let result: Awaited<ReturnType<typeof runSyncCli>>, fetchCalls: number;
      try {
        result = await runSyncCli(['--source', 'default', '--no-pull']);
      } finally {
        fetchCalls = fetchSpy.mock.calls.length;
        fetchSpy.mockRestore();
        resetGateway();
      }
      expect(result.refused?.code).toBe('sync_anchor_relative');
      expect(fetchCalls).toBe(0);
      expect(result.lines.join('\n')).not.toMatch(/cost gate floor|Exceeds floor/);
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pagesOf('default')).toBe(0);
    }, 120_000);

    // Value: protects=an explicit relative --repo that differs from the stored relative anchor is honored: that directory syncs;
    //   fails_when=the guard starts refusing every relative repoPath instead of only the stored anchor itself;
    //   why_new=no other case passes a relative repoPath other than the anchor; seam=none; no_claim=parallel import workers
    //   (--workers 1: a worker opens the configured DATABASE_URL, not this test's isolated Postgres database)
    test('gbrain sync --repo brain (relative, not the stored ".") is honored: brain syncs, the cwd stays untouched', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const brain = join(folder, 'brain');
      mkdirSync(brain);
      execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: brain, stdio: 'pipe' });
      writeFileSync(join(brain, 'inside.md'), '---\ntype: note\ntitle: Inside\n---\n\nA page of the brain.\n');
      execSync('git add -A && git commit -q -m initial', { cwd: brain, stdio: 'pipe' });
      const result = await runSyncCli(['--repo', 'brain', '--no-pull', '--no-embed', '--json', '--workers', '1']);
      expect(result.refused?.code).toBeUndefined();
      expect(result.exit).toBeUndefined();
      const slugs = (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' ORDER BY slug")).map(row => row.slug);
      expect(slugs).toEqual(['inside']);
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    // Value: protects=gbrain sync --repo . with a stored anchor of "." refuses sync_anchor_relative and git-inits nothing (decided: keep the refusal);
    //   fails_when=an explicit --repo bypasses the guard and the cwd is resolved as the brain; why_new=the performSync "." case never runs the CLI
    //   --repo flag through runSingleSourceSync; seam=none; no_claim=none beyond protects
    test('gbrain sync --repo . with a stored "." is refused sync_anchor_relative: no .git, no import', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const result = await runSyncCli(['--repo', '.', '--no-pull', '--no-embed', '--json']);
      expect(result.refused?.code).toBe('sync_anchor_relative');
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pagesOf('default')).toBe(0);
    }, 120_000);

    test('a relative legacy sync.repo_path refuses with the config fix', async () => {
      await engine.setConfig('sync.repo_path', '.');
      const refused = await sync({});
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(refused?.fix?.argv).toEqual(['gbrain', 'config', 'set', 'sync.repo_path', '<dir>']);
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    test('a relative anchor proves no ownership: an explicit absolute path to the cwd is not auto-initialized', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      expect(await isAnchorOwnedSyncPath(engine, { sourceId: 'default' } as never, folder)).toBe(false);
      const failed = await sync({ sourceId: 'default', repoPath: folder });
      expect(failed).not.toBeNull();
      expect(failed?.code).not.toBe('sync_anchor_relative');
      expect(existsSync(join(folder, '.git'))).toBe(false);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
      expect(await isAnchorOwnedSyncPath(engine, { sourceId: 'default' } as never, folder)).toBe(true);
    }, 120_000);

    test('sources set-path --clear clears a relative filesystem path without SQL; an absolute one stays refused', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      expect(await clearConnectorLocalPath(engine, 'default')).toEqual({ prior: '.', connector: false });
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBeNull();
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
      expect((await clearConnectorLocalPath(engine, 'default').catch(error => error)).code).toBe('invalid_params');
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBe(folder);
      // Value: protects=a relative local_path whose source has a canonical owner binding is never cleared (writer_transfer_required);
      //   fails_when=the relative-path clear is moved ahead of the binding check; why_new=sources-set-path-clear covers only a bound
      //   connector; seam=none; no_claim=a real activated managed brain (the binding row is inserted directly)
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
      await engine.executeRaw('INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
        ['default', incarnation, worktree!.id]);
      expect((await clearConnectorLocalPath(engine, 'default').catch(error => error)).code).toBe('writer_transfer_required');
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBe('.');
    }, 120_000);

    // Value: protects=the CLI clear of a relative filesystem path says sync refuses until a directory is set, not that autopilot syncs it;
    //   fails_when=runClearPath drops the connector branch and prints the connector's autopilot line for a filesystem source;
    //   why_new=the case above calls clearConnectorLocalPath directly and never reads the CLI output; seam=none; no_claim=none beyond protects
    test('gbrain sources set-path default --clear on a relative path names the absolute set-path and never promises autopilot sync', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const { lines, exit } = await cli(async () => {
        const { runSources } = await import('../src/commands/sources.ts');
        await runSources(engine, ['set-path', 'default', '--clear']);
      });
      const text = lines.join('\n');
      expect(exit, text).toBeUndefined();
      expect(text).toContain('Cleared source "default" local_path (was .).');
      expect(text).toContain('Sync of "default" refuses until a directory is set: gbrain sources set-path default <absolute-directory>.');
      expect(text).not.toContain('Autopilot keeps syncing');
      expect((await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'"))[0]!.local_path).toBeNull();
    }, 120_000);

    test('doctor default_source_local_path warns on a relative path and names the fix', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('gbrain sources set-path default --clear');
    }, 120_000);

    test('no other reader treats the cwd as a relative source root: write-through, install fallback, cycle source match, import roots, remote submit_job, managed roots', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.setConfig('sync.repo_path', '.');
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const { resolvePageWriteTarget } = await import('../src/core/write-through.ts');
        expect(await resolvePageWriteTarget(engine, 'notes', 'default')).toEqual({ ok: false, skipped: 'repo_not_found' });
        await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
        expect(await resolvePageWriteTarget(engine, 'notes', 'default')).toEqual({ ok: false, skipped: 'repo_not_found' });
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");

        const { installRepoFallback } = await import('../src/commands/autopilot/install-repo.ts');
        expect(await installRepoFallback(engine)).toBeNull();

        const { resolveSourceForDir } = await import('../src/core/cycle.ts');
        expect(await resolveSourceForDir(engine, folder)).toBeUndefined();

        const { listConfiguredRoots } = await import('../src/commands/import.ts');
        expect(await listConfiguredRoots(engine, 'default')).not.toContain(folder);

        const { prepareRemoteJob } = await import('../src/core/minions/submission-authority.ts');
        const remote = { engine, config: {}, dryRun: false, remote: true, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
          auth: { token: 'test-only', clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' }, scopes: ['admin'], sourceId: 'default' } };
        for (const name of ['import', 'lint']) await expect(prepareRemoteJob(remote as never, name, {})).rejects.toThrow('relative path');

        const { refreshManagedFilesystemRoots } = await import('../src/core/persistence/filesystem-guard.ts');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try { await refreshManagedFilesystemRoots(engine); }
        finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
        expect(existsSync(join(folder, '.gbrain-managed'))).toBe(false);
      });
      expect(existsSync(join(folder, '.git'))).toBe(false);
    }, 120_000);

    test('dream and the autopilot cycle run no filesystem phase against the cwd for a relative local_path or sync.repo_path', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.setConfig('sync.repo_path', '.');
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
        const { runDream } = await import('../src/commands/dream.ts');
        const scoped = await runDream(engine, ['--source', 'default', '--phase', 'lint', '--json']) as { brain_dir: string | null };
        expect(scoped.brain_dir).toBeNull();
        const unscoped = await runDream(engine, ['--phase', 'lint', '--json']) as { brain_dir: string | null };
        expect(unscoped.brain_dir).toBeNull();

        const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
        const handlers = new Map<string, (job: unknown) => Promise<{ report: { brain_dir: string | null } }>>();
        await registerBuiltinHandlers({ register(name: string, fn: never) { handlers.set(name, fn); } } as never, engine);
        const cycle = handlers.get('autopilot-cycle')!;
        expect((await cycle({ data: { source_id: 'default', phases: ['recompute_emotional_weight'] }, signal: undefined })).report.brain_dir).toBeNull();
        expect((await cycle({ data: { phases: ['recompute_emotional_weight'] }, signal: undefined })).report.brain_dir).toBeNull();
        expect((await cycle({ data: { repoPath: '.', phases: ['recompute_emotional_weight'] }, signal: undefined })).report.brain_dir).toBeNull();
      });
      expect(existsSync(join(folder, '.git'))).toBe(false);
      expect(await pageCount()).toBe(0);
    }, 120_000);

    // Value: protects=a relative local_path or sync.repo_path never becomes the cwd for folder-to-source matching, fence repair,
    //   page and fact write-through (including the automatic claim of an unbound PGLite source), capture origins, activation
    //   or the per-phase and global maintenance jobs; fails_when=any of those readers resolves "." against process.cwd();
    //   why_new=the reader test above covers write-through, install, cycle, import, submit_job and managed roots only; seam=none;
    //   no_claim=readers that only test whether a root is set (atom, facts and prepared maintenance refuse without an owner)
    test('the remaining readers ignore a relative root: source matching, fence repair, page and fact writes, activation, phase and global maintenance', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-src-')));
      try {
        mkdirSync(join(repo, 'sub'));
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
          const { resolveSourceId, resolveSourceForRepoPath } = await import('../src/core/source-resolver.ts');
          process.chdir(join(repo, 'sub'));
          try {
            expect(await resolveSourceId(engine, null, join(repo, 'sub'))).toBe('notes-a');
            expect((await resolveSourceForRepoPath(engine, join(repo, 'sub')))?.source_id).toBe('notes-a');
          } finally { process.chdir(folder); }

          const { loadFenceSource } = await import('../src/core/fence-repair/repair-io.ts');
          expect((await loadFenceSource(engine, 'default'))?.root).toBeNull();

          const { resolveFactWriteTarget } = await import('../src/core/persistence/fact-write-target.ts');
          expect((await resolveFactWriteTarget(engine, 'default', { local_path: '.', kind: null }, { fileBacked: false, remote: false })).kind).toBe('publish');

          const { operations } = await import('../src/core/operations.ts');
          const ctx = { engine, config: { engine: backend }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', deferEmbeds: true };
          await operations.find(o => o.name === 'put_page')!.handler(ctx as never, { slug: 'notes/kept-in-db', content: '---\ntype: note\ntitle: Kept\n---\n\nA page with no folder of its own.\n' });
          const { getWorktreeBinding } = await import('../src/core/persistence/ownership.ts');
          expect(await getWorktreeBinding(engine, 'default')).toBeNull();
          expect(existsSync(join(folder, 'notes'))).toBe(false);
          await operations.find(o => o.name === 'capture')!.handler(ctx as never, { slug: 'notes', content: 'A captured note.', local_file: join(folder, 'notes.md') });
          expect(await engine.executeRaw("SELECT source_uri FROM pages WHERE source_id='default' AND slug='notes'")).toEqual([{ source_uri: 'cli-file' }]);

          const { activatePersistence } = await import('../src/core/persistence/activation.ts');
          const refused = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true }).then(() => ({}), (error: unknown) => error) as { detail?: string; message?: string };
          expect(refused).toMatchObject({ detail: 'source_path_missing' });
          expect(refused.message).toContain("records the relative local path .");

          await engine.setConfig('sync.repo_path', '.');
          await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
          const { makeCyclePhaseHandler } = await import('../src/core/minions/handlers/cycle-phase.ts');
          const phase = await makeCyclePhaseHandler(engine, 'recompute_emotional_weight')({ id: 1, data: {}, signal: undefined } as never) as { report: { brain_dir: string | null } };
          expect(phase.report.brain_dir).toBeNull();
          const { makeAutopilotGlobalMaintenanceHandler } = await import('../src/core/minions/handlers/autopilot-global-maintenance.ts');
          const brainDirs: Array<string | null | undefined> = [];
          const runCycle = async (_engine: BrainEngine, opts: { phases?: string[]; brainDir?: string | null }) => {
            brainDirs.push(opts.brainDir);
            return { schema_version: '1', timestamp: new Date().toISOString(), duration_ms: 1, status: 'ok', totals: {},
              phases: [{ phase: opts.phases![0], status: 'ok', duration_ms: 1, summary: 'ok', details: {} }] };
          };
          await makeAutopilotGlobalMaintenanceHandler(engine, { runCycle: runCycle as never })({ id: 2, attempts_made: 0, signal: undefined, deadlineAtMs: null, data: { phases: ['orphans'] } } as never);
          expect(brainDirs.length).toBeGreaterThan(0);
          expect(brainDirs.every(dir => dir === null)).toBe(true);
        });
        expect(existsSync(join(folder, '.git'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    test('gbrain config set sync.repo_path refuses a relative path and writes nothing; an absolute one is stored', async () => {
      const { runConfig } = await import('../src/commands/config.ts');
      const refused = await cli(() => runConfig(engine, ['set', 'sync.repo_path', '.']));
      expect(refused.exit).toBe(1);
      expect(refused.lines.join('\n')).toContain('sync.repo_path must be an absolute directory');
      expect(await engine.getConfig('sync.repo_path')).toBeNull();
      const stored = await cli(() => runConfig(engine, ['set', 'sync.repo_path', folder]));
      expect(stored.exit).toBeUndefined();
      expect(await engine.getConfig('sync.repo_path')).toBe(folder);
    }, 120_000);

    test('doctor default_source_local_path warns for any source with a relative path, not only default', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', 'notes')");
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('source "notes-a" has the relative local_path "notes"');
      expect(check?.message).toContain('gbrain sources set-path <id> <absolute-directory>');
    }, 120_000);

    // /ship coverage audit (GBRA-207, #7630).
    // Value: protects=doctor default_source_local_path stays ok when every live source path is absolute and only an archived source is relative;
    //   fails_when=the relative-source query drops its isAbsolute filter or its archived exclusion, so every multi-source brain warns;
    //   why_new=the two doctor cases above assert only the warn side; seam=none; no_claim=other doctor checks (only this check runs)
    test('doctor default_source_local_path stays ok with absolute sources and a relative path only on an archived source', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-abs-')));
      try {
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [folder]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path, archived, archived_at) VALUES ('notes-b', 'notes-b', 'notes', true, now())");
        const check = await defaultSourceLocalPathCheck(engine);
        expect(check?.status).toBe('ok');
        expect(check?.message).not.toContain('relative local_path');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // /ship review fixes (GBRA-207, #7630).
    // Value: protects=doctor names a relative legacy sync.repo_path behind a null default local_path instead of reporting the fallback healthy;
    //   fails_when=the wrapper resolves "." against the cwd (existsSync is true) and the assessor reports "write through sync.repo_path (.)";
    //   why_new=the doctor cases above set a relative local_path, never the legacy key; seam=none; no_claim=other doctor checks
    test('doctor default_source_local_path warns on a relative sync.repo_path behind a null default local_path', async () => {
      await engine.setConfig('sync.repo_path', '.');
      await engine.putPage('notes/live', { type: 'note', title: 'Live', compiled_truth: 'A live default page.', timeline: '' }, { sourceId: 'default' });
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('sync.repo_path is the relative path "."');
      expect(check?.message).toContain('gbrain config set sync.repo_path <absolute-directory>');
    }, 120_000);

    // Value: protects=a successful sync of another source never runs .gitignore upkeep on the cwd's Git repo through a stored relative root;
    //   fails_when=post-sync upkeep takes getDefaultSourcePath's "." (a second non-default source keeps the cwd chain on default)
    //   and writes the managed block into the cwd repo's .gitignore;
    //   why_new=the --all case above never reaches the single-source post-sync upkeep; seam=none;
    //   no_claim=watch mode (the same expression at its second call site), parallel import workers (--workers 1)
    test('gbrain sync --source of an absolute source leaves the cwd repo\'s .gitignore alone when default\'s local_path is "."', async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-repo-')));
      try {
        execSync('git init -q && git config user.email t@example.com && git config user.name T', { cwd: repo, stdio: 'pipe' });
        writeFileSync(join(repo, 'kept.md'), '---\ntype: note\ntitle: Kept\n---\n\nA page of the absolute source.\n');
        execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });
        execSync('git init -q', { cwd: folder, stdio: 'pipe' });
        writeFileSync(join(folder, 'gbrain.yml'), 'storage:\n  db_only:\n    - media/x/\n');
        await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', $1)", [repo]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-b', 'notes-b', $1)", [join(repo, 'elsewhere')]);
        const { exit } = await cli(async () => {
          const { runSync } = await import('../src/commands/sync.ts');
          await runSync(engine, ['--source', 'notes-a', '--no-pull', '--no-embed', '--workers', '1']);
        });
        expect(exit ?? 0).toBe(0);
        expect(await pagesOf('notes-a')).toBe(1);
        expect(existsSync(join(folder, '.gitignore'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 120_000);

    // Value: protects=the remote sources_resolve_path read and the fence census never treat a relative local_path as the host's cwd;
    //   fails_when=resolveSourcePaths realpaths "." (the cwd's Git repo answers) or the census walks the cwd's files;
    //   why_new=the reader cases above cover write and maintenance roots, not these two reads; seam=none; no_claim=the MCP transport
    test('sources_resolve_path refuses and the fence census walks no files for a relative local_path', async () => {
      execSync('git init -q && git config user.email t@example.com && git config user.name T && git add -A && git commit -q -m initial', { cwd: folder, stdio: 'pipe' });
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const { resolveSourcePaths } = await import('../src/core/persistence/resolve-paths.ts');
      const refused = await resolveSourcePaths(engine, 'default', ['notes.md']).then(() => null, (error: { code?: string; message?: string }) => error);
      expect(refused?.code).toBe('not_found');
      expect(refused?.message).toContain('relative local_path');
      const { runFenceCensus } = await import('../src/core/fence-repair/census.ts');
      const [run] = await runFenceCensus(engine, { sourceIds: ['default'], deadline: Date.now() + 60_000 });
      expect(run?.files).toBe('none');
    }, 120_000);

    // Value: protects=gbrain maintain cycles a stale source with a relative local_path without a brain directory (database phases only);
    //   fails_when=maintain passes "." as brainDir, so the lint phase (fixes on by default) and other filesystem phases run in the cwd;
    //   why_new=the dream/autopilot/phase handlers above are separate readers; seam=runCycle spied to record its options and run orphans only;
    //   no_claim=what each filesystem phase would have written (none runs)
    test('gbrain maintain cycles a stale relative-path source with no brain directory', async () => {
      const cycle = await import('../src/core/cycle.ts');
      const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
      await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('notes-a', 'notes-a', '.', $1::jsonb)", [JSON.stringify({ last_full_cycle_at: stale })]);
      await engine.putPage('notes/a-note', { type: 'note', title: 'A note', compiled_truth: 'A note in notes-a.', timeline: '' }, { sourceId: 'notes-a' });
      const real = cycle.runCycle;
      const seen: Array<{ sourceId?: string; brainDir: string | null }> = [];
      const spy = spyOn(cycle, 'runCycle').mockImplementation(async (e, opts) => {
        seen.push({ sourceId: opts.sourceId, brainDir: opts.brainDir ?? null });
        return real(e, { ...opts, phases: ['orphans'] });
      });
      try {
        const { runMaintain } = await import('../src/commands/maintain.ts');
        await cli(() => runMaintain(engine, ['--safe', '--json']));
      } finally { spy.mockRestore(); }
      expect(seen.find(s => s.sourceId === 'notes-a')).toEqual({ sourceId: 'notes-a', brainDir: null });
    }, 120_000);

    // Value: protects=the repair command (sources set-path) and the #2018 write-through leak guard never treat a sibling's relative
    //   local_path as the cwd's tree; fails_when=assertNoOverlappingPath or otherSourceOwning realpaths "." to the cwd, so set-path
    //   refuses overlapping_path and default writes under sync.repo_path skip as another source's tree; why_new=no other case has a
    //   relative sibling; seam=none; no_claim=company-brain admission (same helper)
    test('a sibling with a relative local_path overlaps nothing: set-path to the cwd passes and the leak guard ignores it', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
      const { assertNoOverlappingPath } = await import('../src/core/sources-ops.ts');
      expect(await assertNoOverlappingPath(engine, 'notes-a', folder).then(() => null, (error: { code?: string }) => error.code ?? String(error))).toBeNull();
      const { otherSourceOwning } = await import('../src/core/write-through.ts');
      expect(await otherSourceOwning(engine, 'default', join(folder, 'notes.md'))).toBeNull();
    }, 120_000);

    test('gbrain import of the cwd into a source whose local_path is "." does not stamp it fresh', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes-a', 'notes-a', '.')");
      const { runImport } = await import('../src/commands/import.ts');
      await cli(() => runImport(engine, [folder, '--source', 'notes-a', '--no-embed']));
      expect(await pagesOf('notes-a')).toBe(1);
      const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='notes-a'");
      expect(row!.last_sync_at).toBeNull();
    }, 120_000);
  });
}

describe('#7630: a stalled write\'s diagnosis matches its operation', () => {
  const receipt = (operation: string) => classifyTerminal({ request_id: '11111111-2222-4333-8444-555555555555', source_id: 'default', slug: 'notes/example',
    operation, state: 'failed', error_code: 'preparation_stalled', error_detail: null, recovery: null, blocked_reason: null, compacted: false, intent_kind: null })!;
  const mcp = { transport: 'stdio' as const, isCallable: () => false, preapproved: () => false };

  for (const operation of ['remember', 'put_page', 'add_tag', 'add_link', 'add_timeline_entry', 'takes_add', 'forget_fact']) {
    test(`a foreground ${operation} that ended preparation_stalled inspects the writer and resubmits, never a sync`, () => {
      const verdict = receipt(operation);
      expect(verdict.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
      expect(verdict.action.why).toContain('new request_id');
      const rendered = renderAction(verdict.action, mcp);
      expect(rendered.command).not.toContain('gbrain sync');
    });
  }

  for (const operation of ['extract_facts', 'writer_deactivate']) {
    test(`a stalled ${operation} (maintenance or administration) inspects the writer, with no resubmit and no sync`, () => {
      const verdict = receipt(operation);
      expect(verdict.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
      expect(verdict.action.why).not.toContain('request_id');
      expect(renderAction(verdict.action, mcp).command).not.toContain('gbrain sync');
    });
  }

  test('a recorded sync fault and a sync page receipt keep the sync retry', () => {
    expect(classifyRecordedFault({ source_id: 'default', code: 'preparation_stalled' }).action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
    expect(receipt('submit_job').action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
  });
});
