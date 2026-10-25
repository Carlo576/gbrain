/**
 * G3 of git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md): a strict source (`sources.config.canonical = "git"`)
 * indexes its commits alone, and Git wins. The managed sync pass of such a source:
 *   - imports the committed blob over a database version sync never saw (`db_ahead`), where a source that is not strict
 *     keeps the database version;
 *   - imports a commit over a page the database also moved (drift), where a source that is not strict holds `file_drift`;
 *   - imports the committed bytes of a file whose working tree holds an uncommitted edit, and leaves the edit on disk,
 *     where a source that is not strict holds `worktree_dirty`;
 *   - deletes a page whose file a commit removed while an untracked copy stays on disk, as a page imported from Git does;
 *   - refuses `--working-tree` with `managed_sync_flag_refused`.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/ahead', 'notes/drift', 'notes/dirty', 'notes/removed'];

const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code}`);
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ body: string; deleted: boolean }>(
  "SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
/** A database-only edit: the page moves to a revision no request and no import wrote. */
const databaseOnlyEdit = (engine: BrainEngine, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
  `UPDATE pages SET compiled_truth=$1, knowledge_revision=$2::uuid, revision_write_request_id=NULL WHERE source_id='default' AND slug=$3`, [body, randomUUID(), slug]), TEST_WRITE_ATTRIBUTION));
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);

/**
 * From a first sync: notes/ahead moves in the database only; notes/drift moves in the database and in a commit; notes/dirty
 * gets a commit and then an uncommitted edit on top; notes/removed leaves Git in a commit while its file stays on disk.
 */
async function diverge(engine: BrainEngine, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
  await databaseOnlyEdit(engine, 'notes/drift', 'Written to the database alone.');
  writeFileSync(join(root, 'notes/drift.md'), note('notes/drift', 'The committed edit of notes/drift.'));
  writeFileSync(join(root, 'notes/dirty.md'), note('notes/dirty', 'The committed edit of notes/dirty.'));
  git(root, 'commit', '-qam', 'edit drift and dirty');
  git(root, 'rm', '-q', '--cached', 'notes/removed.md'); git(root, 'commit', '-qm', 'remove notes/removed from git');
  writeFileSync(join(root, 'notes/dirty.md'), note('notes/dirty', 'An uncommitted edit of notes/dirty.'));
}

for (const backend of testBackends()) describe(`[${backend}] G3: a strict source indexes its commits, and Git wins`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, '.gitignore'), '\n');
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test('a source that is not strict keeps the database version and holds drift and the dirty file', () => managedBrain(async ({ engine, root }) => {
    await diverge(engine, root);
    await performManagedSync(engine, { ...OPTS, full: true });
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
    expect((await page(engine, 'notes/drift'))!.body).toContain('Written to the database alone.');
    expect(await holds(engine)).toEqual(expect.arrayContaining(['notes/drift.md file_drift', 'notes/dirty.md worktree_dirty']));
  }, { databaseUrl, setup }), 180_000);

  test('a strict source imports every committed blob over the database, deletes the removed page and holds nothing', () => managedBrain(async ({ engine, root }) => {
    await diverge(engine, root);
    await strict(engine);
    await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
    expect((await page(engine, 'notes/drift'))!.body).toContain('The committed edit of notes/drift.');
    expect((await page(engine, 'notes/dirty'))!.body).toContain('The committed edit of notes/dirty.');
    expect(readFileSync(join(root, 'notes/dirty.md'), 'utf8')).toContain('An uncommitted edit of notes/dirty.');
    expect((await page(engine, 'notes/removed'))!.deleted).toBe(true);
    expect(await holds(engine)).toEqual([]);
    const again = await performManagedSync(engine, OPTS);
    expect(again.status).toBe('up_to_date');
    expect((await page(engine, 'notes/dirty'))!.body).toContain('The committed edit of notes/dirty.');
  }, { databaseUrl, setup }), 180_000);

  test('a strict source refuses --working-tree before anything runs', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await strict(engine);
    writeFileSync(join(root, 'notes/ahead.md'), note('notes/ahead', 'An uncommitted edit.'));
    await expect(performManagedSync(engine, { ...OPTS, workingTree: true })).rejects.toMatchObject({ code: 'managed_sync_flag_refused', detail: '--working-tree' });
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
  }, { databaseUrl, setup }), 180_000);
});
