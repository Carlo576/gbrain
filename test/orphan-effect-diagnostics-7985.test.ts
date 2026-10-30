/**
 * #7985: a parked Git effect recorded under a former canonical binding is refused by the exact retry (source_changed,
 * the guard stays) and is never selected by the bulk retry of the current binding. The diagnostics now tell the two apart:
 * the parked groups (doctor \`parked_effects\`, \`sources writer status\`) give such effects their own group naming the
 * recorded worktree, the current one, the requests and the settle preview; doctor's per-effect command is that preview;
 * the exact retry refusal names both bindings and the settle preview; the bulk retry names the effects it leaves out.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { retryParkedEffects } from '../src/core/persistence/effect-retry.ts';
import { retrySourceParkedCode } from '../src/core/persistence/git-durability-administration.ts';
import { settleEffects } from '../src/core/persistence/effect-settle.ts';
import { readParkedGroups } from '../src/core/persistence/parked-groups.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { isPhysicalRootMetadata } from '../src/core/persistence/physical-root.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

const backends: Array<string | undefined> = [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])];
const put = async (ctx: OperationContext, slug: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\n${body}\n`,
    ...await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' }).then(page => page ? { expected_revision: page.revision } : {}) } });
async function sql(engine: BrainEngine, statement: string, params: unknown[]) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(statement, params); });
}
/** Parks the newest Git effect of a page on git_unavailable (the resident consumer stopped); returns its ids and worktree. */
async function park(engine: BrainEngine, slug: string) {
  await disposePersistenceConsumer(engine);
  const [effect] = await engine.executeRaw<{ id: number; request_id: string; worktree_id: string }>(`SELECT e.id,r.request_id::text AS request_id,
    e.worktree_id::text AS worktree_id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.kind='git' AND r.slug=$1 ORDER BY e.id DESC LIMIT 1`, [slug]);
  await sql(engine, `UPDATE persistence_effects SET state='failed',error_code='targets_parked',execution_token=NULL,claim_expires_at=NULL,
    data=data||jsonb_build_object('parked',jsonb_build_array(jsonb_build_object('slug',$2::text,'error_code','git_unavailable'))) WHERE id=$1`, [effect!.id, slug]);
  return effect!;
}

describe.each(backends.map(url => [url ? 'postgres' : 'pglite', url] as const))('#7985 effects of a former binding (%s)', (_name, url) => {
  test('the diagnostics name a former-binding effect, its recorded binding and the settle preview, apart from the current binding', () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'aa/page', 'Parked under the old binding.');
    const orphan = await park(engine, 'aa/page');
    const old = (await getWorktreeBinding(engine, 'default'))!;
    expect(orphan.worktree_id).toBe(old.worktree_id);

    const moved = join(dirname(root), 'moved');
    cpSync(root, moved, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) });
    await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'default', path: moved });
    const current = (await getWorktreeBinding(engine, 'default'))!;
    expect(current.worktree_id).not.toBe(old.worktree_id);
    await put(ctx, 'bb/page', 'Parked under the current binding.');
    const live = await park(engine, 'bb/page');
    expect(live.worktree_id).toBe(current.worktree_id);

    const settleCode = ['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--parked-code', 'git_unavailable', '--dry-run'];
    const groups = await readParkedGroups(engine, ['default']);
    expect(groups).toMatchObject([
      { source_id: 'default', code: 'git_unavailable', effects: 1, targets: 1, command: ['gbrain', 'sources', 'writer', 'retry-effects', 'default', '--parked-code', 'git_unavailable', '--dry-run'] },
      { source_id: 'default', code: 'git_unavailable', effects: 1, targets: 1, command: settleCode,
        former_binding: { reason: 'binding_changed', worktree_ids: [old.worktree_id], current_worktree_id: current.worktree_id, requests: [orphan.request_id] } },
    ]);
    expect(groups[0]).not.toHaveProperty('former_binding');
    expect(groups[1]!.next).toContain('the bulk retry selects none of them, so its zero is not a clearance');
    expect(groups[1]!.next).toContain(orphan.request_id);

    const doctor = await checkParkedEffects(engine);
    expect(doctor.details).toMatchObject({ parked_effects: 2, parked_groups: groups });
    const listed = (doctor.details as { effects: Array<{ request_id: string; command?: string; former_binding?: boolean }> }).effects;
    expect(listed.find(effect => effect.request_id === orphan.request_id)).toMatchObject({ former_binding: true,
      command: `gbrain sources writer settle-effects default --request-id ${orphan.request_id} --dry-run` });
    expect(listed.find(effect => effect.request_id === live.request_id)).toMatchObject({
      command: `gbrain sources writer retry-effects default --request-id ${live.request_id} --dry-run` });
    expect(listed.find(effect => effect.request_id === live.request_id)).not.toHaveProperty('former_binding');

    const refusal = await retryParkedEffects(engine, 'default', orphan.request_id, true).then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'source_changed', message: 'The effect canonical binding changed.',
      fix: { argv: ['gbrain', 'sources', 'writer', 'settle-effects', 'default', '--request-id', orphan.request_id, '--dry-run', '--json'] } });
    expect(refusal.suggestion).toContain(`worktree ${old.worktree_id}`);
    expect(refusal.suggestion).toContain(`now bound to worktree ${current.worktree_id}`);

    const bulk = await retrySourceParkedCode(engine, 'default', 'git_unavailable', true);
    expect(bulk).toMatchObject({ requests: 1, queued: 1, refused: [],
      former_worktree: { effects: 1, command: settleCode, worktree_ids: [old.worktree_id], requests: [orphan.request_id] } });
    expect(String((bulk.former_worktree as { why: string }).why)).toContain('its counts do not include them');

    expect(await settleEffects(engine, { sourceId: 'default', requestId: orphan.request_id })).toMatchObject({ settleable: 0, refused: 1,
      effects: [{ request_id: orphan.request_id, action: 'refused', refusal: { code: 'no_covering_receipt' } }] });

    await sql(engine, 'UPDATE persistence_effects SET source_incarnation=$2::uuid WHERE id=$1', [orphan.id, randomUUID()]);
    const replaced = (await readParkedGroups(engine, ['default']))[1]!;
    expect(replaced).toMatchObject({ command: settleCode, former_binding: { reason: 'source_replaced', requests: [orphan.request_id] } });
    expect(replaced.next).toContain('earlier incarnation of the source');
  }, { databaseUrl: url, setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); } }), 240_000);
});
