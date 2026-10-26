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
 * - sync refuses `sync_anchor_relative` (exit 3, a fix naming `gbrain sources set-path <id> --clear`) for a relative
 *   `local_path` reached by `--source` (the anchor read) or by `--all` (the row's path passed through), and for a relative
 *   legacy `sync.repo_path`; the folder gets no `.git` and nothing is imported;
 * - a relative anchor never proves ownership, so even an explicit absolute path to the cwd is not auto-initialized;
 * - `gbrain sources set-path <id> --clear` clears a relative filesystem path without SQL, and still refuses an absolute one;
 * - doctor's `default_source_local_path` warns on a relative path;
 * - a stalled foreground write's diagnosis inspects the writer and says to resubmit with a new request_id, while a
 *   recorded sync fault keeps its sync retry.
 *
 * PGLite always; Postgres when DATABASE_URL is set (test/e2e/sync-relative-anchor-refusal-7630-postgres.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

    test('--source default with local_path "." refuses sync_anchor_relative: no .git, no commit, no import', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const before = await pageCount();
      const refused = await sync({ sourceId: 'default' });
      expect(refused?.code).toBe('sync_anchor_relative');
      expect(refused?.fix?.argv).toEqual(['gbrain', 'sources', 'set-path', 'default', '--clear']);
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
    }, 120_000);

    test('doctor default_source_local_path warns on a relative path and names the fix', async () => {
      await engine.executeRaw("UPDATE sources SET local_path='.' WHERE id='default'");
      const check = await defaultSourceLocalPathCheck(engine);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('gbrain sources set-path default --clear');
    }, 120_000);
  });
}

describe('#7630: a stalled write\'s diagnosis matches its operation', () => {
  const receipt = (operation: string) => classifyTerminal({ request_id: '11111111-2222-4333-8444-555555555555', source_id: 'default', slug: 'notes/example',
    operation, state: 'failed', error_code: 'preparation_stalled', error_detail: null, recovery: null, blocked_reason: null, compacted: false, intent_kind: null })!;
  const mcp = { transport: 'stdio' as const, isCallable: () => false, preapproved: () => false };

  for (const operation of ['remember', 'put_page']) {
    test(`a foreground ${operation} that ended preparation_stalled inspects the writer and resubmits, never a sync`, () => {
      const verdict = receipt(operation);
      expect(verdict.action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
      expect(verdict.action.why).toContain('new request_id');
      const rendered = renderAction(verdict.action, mcp);
      expect(rendered.command).not.toContain('gbrain sync');
    });
  }

  test('a recorded sync fault and a sync page receipt keep the sync retry', () => {
    expect(classifyRecordedFault({ source_id: 'default', code: 'preparation_stalled' }).action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
    expect(receipt('submit_job').action.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
  });
});
