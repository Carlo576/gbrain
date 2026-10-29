/**
 * #7900: after a host move, apply-migrations stopped at v0.53.0 content-checkpoints with "The canonical root changed
 * after setup began", forever, and `gbrain repair content-receipt-root` found nothing to repair.
 *
 * Shape: content setup on the old host created an owned root and stopped at stage `owner` (an existing brain waits
 * for the writer to be claimed and shared-skill persistence activated). The brain then moved: the content was copied
 * to the new host's root, the source pointed there, claimed and activated on the new host identity. The setup
 * checkpoint still named the old host's root. The migration resumes that setup and refused, and the repair only read
 * complete receipts, so the operator had no supported way through.
 *
 * Now the refusal names the repair, the repair lists the stale checkpoint with its exit (a self-transfer on the owner
 * host re-verifies the tree and rebinds the checkpoint), and after it the migration completes and the source reads
 * fresh. Nothing is rewritten without that explicit, verified step.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { ownedContentFreshness, staleOwnedContent } from '../src/core/shared-skills/content-freshness.ts';
import { runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import { contentSetupKey, setupSharedBrainContent } from '../src/core/shared-skills/setup.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';

const ctxOf = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
  remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

async function checkpoint(engine: BrainEngine) {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  return JSON.parse((await engine.getConfig(contentSetupKey('default', incarnation)))!) as { root: string; stage: string; status: string };
}

async function repairPreview(engine: BrainEngine) {
  const { contentReceiptRootRepair } = await import('../src/core/repair/content-receipt-root.ts');
  const { repairSpec } = await import('../src/core/repair/registry.ts');
  return runRepair(ctxOf(engine) as never, contentReceiptRootRepair, await resolveRepairScope(engine, 'default'),
    { apply: false, explicit: true, spec: repairSpec('content-receipt-root' as never), sourceFlag: 'default' });
}

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const arms = [{ backend: 'pglite', databaseUrl: undefined as string | undefined },
  ...(process.env.DATABASE_URL ? [{ backend: 'postgres', databaseUrl: process.env.DATABASE_URL }] : [])];

for (const { backend, databaseUrl } of arms) for (const git of [false, true]) {
  describe(`#7900 v0.53.0 content checkpoint after a host move (${backend}, ${git ? 'Git repository' : 'content directory'})`, () => {
    test('the refusal and the repair name a way through; after the verified self-transfer the migration completes and the source reads fresh', async () => {
      const base = mkdtempSync(join(tmpdir(), 'gbrain-7900-'));
      const oldHome = join(base, 'old-host-home'), newHome = join(base, 'new-host-home');
      const oldRoot = join(base, 'old-host', 'content'), newRoot = join(base, 'new-host', 'content');
      mkdirSync(join(base, 'old-host')); mkdirSync(join(base, 'new-host'));
      const { engine, close } = await withEnv({ GBRAIN_HOME: oldHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => isolatedSharedSkillsEngine(databaseUrl));
      try {
        const oldHost = await withEnv({ GBRAIN_HOME: oldHome }, async () => {
          const receipt = await setupSharedBrainContent(ctxOf(engine), { sourceId: 'default', root: oldRoot, ...(git ? { git: 'init' as const } : {}) });
          expect(receipt).toMatchObject({ root: oldRoot, owned_root: true, stage: 'owner', repository_kind: git ? 'git' : 'content_directory' });
          writeFileSync(join(oldRoot, 'notes.md'), '# notes\n');
          return localHostId();
        });
        cpSync(oldRoot, newRoot, { recursive: true });
        await withEnv({ GBRAIN_HOME: newHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          try {
            expect(localHostId()).not.toBe(oldHost);
            await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [newRoot]);
            await claimWorktree(engine, 'default', newRoot);
            await activateSharedSkillPersistence(engine, { confirmQuiesced: true });

            const refused = await refusal(() => runSharedSkillsMigration(ctxOf(engine)));
            expect(refused.message).toBe('The canonical root changed after setup began.');
            expect(refused.suggestion).toContain('gbrain repair content-receipt-root --source default');
            expect((refused as { fix?: { argv?: string[] } }).fix?.argv).toEqual(['gbrain', 'repair', 'content-receipt-root', '--source', 'default']);
            expect(await checkpoint(engine)).toMatchObject({ root: oldRoot, stage: 'owner' });

            expect((await staleOwnedContent(engine, ['default'])).map(row => row.sourceId)).toEqual(['default']);
            const preview = await repairPreview(engine);
            expect(preview.listing).toEqual([expect.objectContaining({ item: 'default', class: 'tree_mismatch' })]);
            const fix = (preview.details?.refused as Array<{ fix: { argv: string[]; then: { argv: string[]; then?: { argv: string[] } } } }>)[0].fix;
            expect([fix.argv.slice(0, 7), fix.then.argv.slice(0, 5), fix.then.then?.argv.slice(0, 6)]).toEqual([
              ['gbrain', 'sources', 'writer', 'transfer', 'prepare', 'default', '--self-transfer'],
              ['gbrain', 'sources', 'writer', 'transfer', 'accept'],
              ['gbrain', 'sources', 'writer', 'activate', '--confirm-quiesced', '--shared-skills']]);
            expect(await checkpoint(engine)).toMatchObject({ root: oldRoot, stage: 'owner' });

            const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare',
              { source_id: 'default', self_transfer: true, ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as { owner_epoch: string; manifest: { digest: string } };
            const accepted = await runPersistenceAdministration(engine, 'writer_transfer_accept', { source_id: 'default', path: newRoot, expected_epoch: prepared.owner_epoch,
              manifest: prepared.manifest.digest, self_transfer: true, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') }) as { content_receipts: unknown[] };
            expect(accepted.content_receipts).toEqual([expect.objectContaining({ source_id: 'default', from: oldRoot, to: newRoot })]);
            await activateSharedSkillPersistence(engine, { confirmQuiesced: true });

            const report = await runSharedSkillsMigration(ctxOf(engine));
            expect(report.status).not.toBe('conflict');
            expect(await checkpoint(engine)).toMatchObject({ root: newRoot, stage: 'complete', status: 'ready' });
            expect(await staleOwnedContent(engine, ['default'])).toEqual([]);
            expect((await ownedContentFreshness(engine, ['default'])).map(row => row.sourceId)).toEqual(['default']);
            expect((await repairPreview(engine)).listing).toEqual([]);
          } finally { await disposePersistenceConsumer(engine); }
        });
      } finally { await close(); rmSync(base, { recursive: true, force: true }); }
    }, 240_000);
  });
}
