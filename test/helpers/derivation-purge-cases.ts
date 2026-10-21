/**
 * Shared cases for purge, forget and demotion against page_segment_derivations (Wave B PR 4 lane 4a, round 2; spec 11):
 * after a fact purge no derivation row may hold the purged claim and the purge receipt reports the store complete,
 * whether the row belongs to an occurrence an append retired before the purge, to a derivation that read the page
 * before the purge and tried to write after it, or to a segmented body the page was demoted from. A fences row keeps
 * fence digests, never the fence text, and a forget deletes the unpaid rows of occurrences no longer live.
 *
 * test/large-pages/derivation-purge.test.ts runs them on PGLite; test/e2e/derivation-purge-postgres.test.ts on PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { __setBeforeDerivationWriteForTests, segmentDeriveWork } from '../../src/core/page-body/segment-derive.ts';
import { incrementalFactsFenceView, segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { deriveAll, KINDS, liveOccurrences, resetDeriveWork, storedPage } from './derivation-equivalence-cases.ts';
import { conversationBody } from './conversation-page.ts';
import { openAppendBrain, type AppendBrain } from './append-brain.ts';

const SOURCE = 'default';
const prose = (bytes: number, seed: number) => conversationBody(bytes, { seed }).replace(/^## Day \\d+$/gm, 'Next day.');

/** A segmented page whose truth ends with a facts fence: `claim` in a row that also links a person, then a short timeline. */
function purgePage(claim: string): string {
  return ['---\ntype: person\ntitle: Purge Example\n---\n\nIntro: met [[people/alice-example]].\n\n', prose(1_300_000, 41), '\n\n## Facts\n\n',
    '<!--- gbrain:facts:begin -->\n',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n',
    '|---|---|---|---|---|---|---|---|---|---|\n',
    `| 1 | ${claim} | fact | 0.9 | world | low | 2026-03-01 | | [[people/alice-example]] | |\n`,
    '| 2 | prefers email | preference | 0.8 | world | low | 2026-02-01 | | user | |\n',
    '<!--- gbrain:facts:end -->\n\n<!-- timeline -->\n\n- **2026-04-02** | Met [[people/alice-example]]\n'].join('');
}

/** Derivation rows of a page whose output or receipt holds `claim` (as the purge receipt probes the store). */
async function holders(engine: BrainEngine, pageId: number, claim: string): Promise<Array<{ pipeline: string; occurrence_id: number }>> {
  return (await engine.executeRaw<{ pipeline: string; occurrence_id: string }>(`SELECT pipeline, occurrence_id::text AS occurrence_id FROM page_segment_derivations
    WHERE page_id=$1 AND (strpos(lower(COALESCE(output::text,'')),$2)>0 OR strpos(lower(COALESCE(receipt::text,'')),$2)>0) ORDER BY pipeline, occurrence_id`,
  [pageId, claim.toLowerCase()])).map(row => ({ pipeline: row.pipeline, occurrence_id: Number(row.occurrence_id) }));
}

export function registerDerivationPurgeCases(kind: 'pglite' | 'postgres'): void {
  describe(`purge leaves no derivation row holding the claim (${kind})`, () => {
    let brain: AppendBrain;
    beforeAll(async () => {
      brain = await openAppendBrain(kind);
      await brain.engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example fixture.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
    }, 600_000);
    afterAll(() => brain.close(), 120_000);

    const seed = async (slug: string, claim: string) => {
      await brain.seed(slug, purgePage(claim));
      await runExtractFacts(brain.engine, { slugs: [slug] });
      const [fact] = await brain.engine.executeRaw<{ id: number }>(
        'SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3 AND expired_at IS NULL', [SOURCE, slug, claim]);
      expect(fact).toBeDefined();
      return Number(fact!.id);
    };

    const purge = async (id: number) => {
      const dry = await brain.call('purge_fact', { id, dry_run: true });
      expect(dry.body.confirm_token).toBeString();
      const done = await brain.call('purge_fact', { id, confirm: dry.body.confirm_token, expected_revision: dry.body.expected_revision });
      expect(done.body.state).toBe('committed');
      return done.body as Record<string, any>;
    };

    /** The receipt's page_segment_derivations report, and that no store is left incomplete. */
    const complete = (receipt: Record<string, any>) => {
      const stores = receipt.stores as Array<{ store: string; status: string }>;
      expect(stores.filter(s => s.status === 'incomplete')).toEqual([]);
      const store = stores.find(s => s.store === 'page_segment_derivations');
      expect(store && ['deleted', 'not_present'].includes(store.status)).toBe(true);
    };

    test('a purge after an append retired the occurrence holding the claim deletes its rows', async () => {
      const slug = 'notes/purge-retired', claim = 'Purge Example door code is 5528';
      const id = await seed(slug, claim);
      const page = await storedPage(brain.engine, slug);
      await deriveAll(brain.engine, page);
      const held = await holders(brain.engine, page.id, claim);
      expect(held.length).toBeGreaterThan(0);
      const res = await brain.call('append_page', { slug, text: 'Appended note: nothing about the claim.\n', region: 'truth', request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const live = await liveOccurrences(brain.engine, page.id);
      expect(held.filter(row => !live.has(row.occurrence_id)).length).toBeGreaterThan(0);
      complete(await purge(id));
      expect(await holders(brain.engine, page.id, claim)).toEqual([]);
    }, 600_000);

    test('a derivation that read the page before a purge does not write its rows after it', async () => {
      const slug = 'notes/purge-race', claim = 'Purge Example badge number is 7731';
      const id = await seed(slug, claim);
      const page = await storedPage(brain.engine, slug);
      let receipt: Record<string, any> | null = null;
      __setBeforeDerivationWriteForTests(async () => {
        if (receipt) return;
        receipt = {};
        receipt = await purge(id);
      });
      resetDeriveWork();
      try { await deriveAll(brain.engine, page); } finally { __setBeforeDerivationWriteForTests(null); }
      expect(receipt).not.toBeNull();
      expect(await holders(brain.engine, page.id, claim)).toEqual([]);
      complete(receipt!);
      expect(KINDS.reduce((n, k) => n + segmentDeriveWork[k].skipped, 0)).toBeGreaterThan(0);
    }, 600_000);

    test('a fences row keeps the fence digest, not its text; a current fence run is read again for it', async () => {
      const slug = 'notes/fence-digest', claim = 'Purge Example vault code is 9902';
      await seed(slug, claim);
      const page = await storedPage(brain.engine, slug);
      await deriveAll(brain.engine, page);
      const fences = await brain.engine.readSegmentDerivations(page.id, { kind: 'fences' });
      expect(fences.length).toBeGreaterThan(0);
      expect(fences.filter(row => JSON.stringify(row.output).includes('gbrain:facts:begin') || JSON.stringify(row.output).toLowerCase().includes(claim.toLowerCase()))).toEqual([]);
      resetDeriveWork();
      const view = await incrementalFactsFenceView(brain.engine, page);
      expect(view).toEqual(await segmentedFactsFenceView(brain.engine, page));
      expect(view.body.facts.map(f => f.claim)).toContain(claim);
      expect({ derived: segmentDeriveWork.fences.derived, reread: segmentDeriveWork.fences.reread }).toEqual({ derived: 0, reread: 1 });
    }, 600_000);

    test('a forget after an append retired an occurrence deletes the unpaid rows of every occurrence no longer live', async () => {
      const slug = 'notes/forget-retired', claim = 'Purge Example gate code is 3318';
      const id = await seed(slug, claim);
      const page = await storedPage(brain.engine, slug);
      await deriveAll(brain.engine, page);
      const res = await brain.call('append_page', { slug, text: 'Appended note: nothing about the claim.\n', region: 'truth', request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const retired = async () => {
        const live = await liveOccurrences(brain.engine, page.id);
        return (await brain.engine.readSegmentDerivations(page.id)).filter(row => KINDS.includes(row.kind as never) && !live.has(row.occurrenceId)).length;
      };
      expect(await retired()).toBeGreaterThan(0);
      expect((await forgetFactInFence(brain.engine, id, { sourceId: SOURCE })).ok).toBe(true);
      expect(await retired()).toBe(0);
    }, 600_000);

    test('a purge after the page was demoted to inline leaves no row of its segmented body', async () => {
      const slug = 'notes/purge-demoted', claim = 'Purge Example locker is 4410';
      const id = await seed(slug, claim);
      const page = await storedPage(brain.engine, slug);
      await deriveAll(brain.engine, page);
      expect((await holders(brain.engine, page.id, claim)).length).toBeGreaterThan(0);
      const [row] = await brain.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE id=$1', [page.id]);
      const small = purgePage(claim).replace(prose(1_300_000, 41), 'Short body now.');
      const res = await brain.call('put_page', { slug, content: small, expected_revision: row!.r, request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const [after] = await brain.engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE id=$1', [page.id]);
      expect(after!.body_storage).toBe('inline');
      complete(await purge(id));
      expect(await holders(brain.engine, page.id, claim)).toEqual([]);
    }, 600_000);
  });
}
