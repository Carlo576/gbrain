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
import { __setAfterDerivationSweepBatchForTests, __setBeforeDerivationWriteForTests, __setDerivationSweepLimitsForTests, __setDerivationSweepWorkForTests, derivationSweepStatements, derivationSweepWork,
  segmentDeriveWork } from '../../src/core/page-body/segment-derive.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
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

/** A segmented page whose last truth paragraph states `text` next to a link, so its links rows carry it in an excerpt. */
function prosePage(text: string, seed: number): string {
  return ['---\ntype: note\ntitle: Prose Example\n---\n\n', prose(1_300_000, seed), `\n\nClosing: met [[people/alice-example]]. ${text}.\n`].join('');
}

/** Derivation rows of a page whose output or receipt holds `text` byte for byte (no case folding on either side). */
async function exactHolders(engine: BrainEngine, pageId: number, text: string): Promise<Array<{ pipeline: string; occurrence_id: number }>> {
  return (await engine.executeRaw<{ pipeline: string; occurrence_id: string }>(`SELECT pipeline, occurrence_id::text AS occurrence_id FROM page_segment_derivations
    WHERE page_id=$1 AND (strpos(COALESCE(output::text,''),$2)>0 OR strpos(COALESCE(receipt::text,''),$2)>0) ORDER BY pipeline, occurrence_id`,
  [pageId, text])).map(row => ({ pipeline: row.pipeline, occurrence_id: Number(row.occurrence_id) }));
}

/**
 * Per page of the source: derivation rows no live segment backs (occurrence retired, page inline or soft-deleted), and
 * whose lowercased output and receipt text match the LIKE `pattern` (ASCII, so lowercasing is the same everywhere).
 */
async function unbackedRows(engine: BrainEngine, pattern = '%'): Promise<Map<number, number>> {
  const rows = await engine.executeRaw<{ page_id: number; n: number }>(`SELECT d.page_id, count(*)::int AS n FROM page_segment_derivations d
    JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1 AND (p.deleted_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=d.page_id
      AND m.occurrence_id=d.occurrence_id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.sha256=d.segment_sha256))
      AND lower(COALESCE(d.output::text,'') || ' ' || COALESCE(d.receipt::text,'')) LIKE $2
    GROUP BY d.page_id`, [SOURCE, pattern]);
  return new Map(rows.map(row => [Number(row.page_id), Number(row.n)]));
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

    /**
     * A page that is not purged retires the occurrence whose links rows carry `planted` (an append replaces its last
     * segment), so only the purge's derivation sweep can reach those rows.
     */
    const retiredHolder = async (slug: string, planted: string, seedNo: number) => {
      await brain.seed(slug, prosePage(planted, seedNo));
      const page = await storedPage(brain.engine, slug);
      await deriveAll(brain.engine, page);
      const res = await brain.call('append_page', { slug, text: 'Appended note: nothing more.\n', region: 'truth', request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const live = await liveOccurrences(brain.engine, page.id);
      const held = await exactHolders(brain.engine, page.id, planted);
      expect(held.length).toBeGreaterThan(0);
      expect(held.filter(row => live.has(row.occurrence_id))).toEqual([]);
      return page;
    };

    const derivationStore = (receipt: Record<string, any>) =>
      (receipt.stores as Array<{ store: string; status: string; remaining?: number }>).find(s => s.store === 'page_segment_derivations');

    for (const variant of [
      { name: 'Greek capitals (final sigma)', claim: 'ΤΟ ΚΛΕΙΔΙ ΤΗΣ ΑΠΟΘΗΚΗΣ ΕΙΝΑΙ 2207', planted: 'ΤΟ ΚΛΕΙΔΙ ΤΗΣ ΑΠΟΘΗΚΗΣ ΕΙΝΑΙ 2207', n: 1 },
      { name: 'Turkish dotted capital I', claim: 'İSTANBUL DEPOSU KODU 6114', planted: 'İSTANBUL DEPOSU KODU 6114', n: 2 },
      { name: 'other case and spacing', claim: 'Purge Example  lift code is 6610', planted: 'purge example LIFT code is 6610', n: 3 },
      { name: 'Greek capitals, stored in lowercase with final sigma', claim: 'Ο ΚΩΔΙΚΟΣ ΤΗΣ ΑΠΟΘΗΚΗΣ ΕΙΝΑΙ 3308', planted: 'ο κωδικος της αποθηκης ειναι 3308', n: 4 },
      { name: 'Greek lowercase with final sigma, stored in capitals', claim: 'ο αριθμος της πορτας ειναι 7719', planted: 'Ο ΑΡΙΘΜΟΣ ΤΗΣ ΠΟΡΤΑΣ ΕΙΝΑΙ 7719', n: 5 },
      { name: 'Turkish dotted capital I, stored as JavaScript lowercases it', claim: 'İZMİR DEPOSU KODU 5521', planted: 'İZMİR DEPOSU KODU 5521'.toLowerCase(), n: 6 },
    ]) {
      test(`a purge deletes a retired row stating the claim in its normalized form: ${variant.name}`, async () => {
        const holder = await retiredHolder(`notes/normalized-holder-${variant.n}`, variant.planted, 50 + variant.n);
        const id = await seed(`notes/normalized-purge-${variant.n}`, variant.claim);
        const receipt = await purge(id);
        expect({ rows: await exactHolders(brain.engine, holder.id, variant.planted), receipt: derivationStore(receipt)?.status })
          .toEqual({ rows: [], receipt: 'deleted' });
        complete(receipt);
      }, 600_000);
    }

    test('a purge sweeps only rows of the pages it rewrote and rows no live segment backs, matching whole words', async () => {
      const claim = 'Plays oboe';
      const unrelated = await retiredHolder('notes/sweep-unrelated', 'Alice Example plays oboes on weekends', 61);
      const retired = await retiredHolder('notes/sweep-retired', 'Alice Example PLAYS OBOE', 62);
      await brain.seed('notes/sweep-live', prosePage(claim, 63));
      const live = await storedPage(brain.engine, 'notes/sweep-live');
      await deriveAll(brain.engine, live);
      const liveHeld = await exactHolders(brain.engine, live.id, claim);
      expect(liveHeld.length).toBeGreaterThan(0);
      const id = await seed('notes/sweep-purge', claim);
      const target = await storedPage(brain.engine, 'notes/sweep-purge');
      await deriveAll(brain.engine, target);
      const unbacked = await unbackedRows(brain.engine);
      const unrelatedRows = (await brain.engine.readSegmentDerivations(unrelated.id)).length;
      const retiredHeld = (await exactHolders(brain.engine, retired.id, 'Alice Example PLAYS OBOE')).length;
      expect(unbacked.has(live.id)).toBe(false);
      const worded = await unbackedRows(brain.engine, '%plays%oboe%');
      __setDerivationSweepWorkForTests(true);
      let receipt: Record<string, any>;
      let work: typeof derivationSweepWork;
      try { receipt = await purge(id); work = [...derivationSweepWork]; } finally { __setDerivationSweepWorkForTests(false); }
      expect(work.some(w => w.pageId === target.id && w.scanned > 0)).toBe(true);
      const expected = [...unbacked].filter(([pageId]) => pageId !== target.id).sort((a, b) => a[0] - b[0])
        .map(([pageId, scanned]) => ({ pageId, scanned, normalized: worded.get(pageId) ?? 0, deleted: pageId === retired.id ? retiredHeld : 0 }));
      expect(work.filter(w => w.pageId !== target.id)).toEqual(expected);
      expect(work.find(w => w.pageId === live.id)).toBeUndefined();
      const others = work.filter(w => w.pageId !== target.id);
      expect(others.reduce((n, w) => n + w.normalized, 0)).toBe([...worded].filter(([pageId]) => pageId !== target.id).reduce((n, [, k]) => n + k, 0));
      expect(others.reduce((n, w) => n + w.normalized, 0)).toBeLessThan(others.reduce((n, w) => n + w.scanned, 0));
      expect(expected.find(w => w.pageId === unrelated.id)?.deleted).toBe(0);
      expect(unbacked.get(unrelated.id)).toBeLessThan(unrelatedRows);
      expect((await brain.engine.readSegmentDerivations(unrelated.id)).length).toBe(unrelatedRows);
      expect(await exactHolders(brain.engine, retired.id, 'Alice Example PLAYS OBOE')).toEqual([]);
      expect(await exactHolders(brain.engine, live.id, claim)).toEqual(liveHeld);
      expect(derivationStore(receipt!)).toMatchObject({ status: 'out_of_scope', reason: 'source_prose', remaining: liveHeld.length });
      expect((receipt!.stores as Array<{ status: string }>).filter(s => s.status === 'incomplete')).toEqual([]);
    }, 600_000);

    test('a sweep records no work unless a test asks for it', async () => {
      const id = await seed('notes/sweep-unrecorded', 'Purge Example shed code is 1186');
      __setDerivationSweepWorkForTests(false);
      await purge(id);
      expect(derivationSweepWork).toEqual([]);
    }, 600_000);

    test('a statement timeout of the derivation sweep fails the purge with the typed code and purges nothing', async () => {
      const claim = 'Purge Example safe code is 2093';
      const holder = await retiredHolder('notes/sweep-timeout-holder', claim, 64);
      const id = await seed('notes/sweep-timeout', claim);
      const held = await exactHolders(brain.engine, holder.id, claim);
      const dry = await brain.call('purge_fact', { id, dry_run: true });
      let seen = 0;
      installFaultHook(point => {
        if (point !== 'purge:derivation_sweep') return;
        seen++;
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      });
      let failed: { isError: boolean; body: Record<string, any> };
      try { failed = await brain.call('purge_fact', { id, confirm: dry.body.confirm_token, expected_revision: dry.body.expected_revision }); }
      finally { installFaultHook(undefined); }
      expect(seen).toBe(1);
      expect({ isError: failed.isError, code: failed.body.error ?? failed.body.code }).toEqual({ isError: true, code: 'purge_lookup_timeout' });
      expect(failed.body.state).not.toBe('committed');
      const [fact] = await brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id=$1', [id]);
      expect(Number(fact!.n)).toBe(1);
      expect(await exactHolders(brain.engine, holder.id, claim)).toEqual(held);
      const receipt = await purge(id);
      expect({ rows: await exactHolders(brain.engine, holder.id, claim), receipt: derivationStore(receipt)?.status }).toEqual({ rows: [], receipt: 'deleted' });
    }, 600_000);

    /** An inline page whose derivation rows no live segment backs: `holding` state `claim`, `common` more state its words in order. */
    const candidateRowsPage = async (slug: string, claim: string, common: number, holding: number) => {
      await brain.engine.putPage(slug, { type: 'note', title: 'Batch Rows', compiled_truth: 'Batch rows fixture.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
      const [row] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
      const [first, ...rest] = claim.split(' ');
      await brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
        SELECT $1, 'links', g, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done',
          jsonb_build_object('candidates', jsonb_build_array(jsonb_build_object('context',
            CASE WHEN g <= $3 THEN 'Note: ' || $4 || ' today' ELSE $5 || ' row ' || g || ' said ' || $6 || ' not' END))), NULL
        FROM generate_series(1, $2::int) g`, [Number(row!.id), common + holding, holding, claim, first, rest.join(' ')]);
      expect(await exactHolders(brain.engine, Number(row!.id), claim)).toHaveLength(holding);
      return Number(row!.id);
    };

    test('a sweep and its receipt walk thousands of candidate rows in statements of bounded rows, and the purge completes', async () => {
      const claim = 'Purge Example hatch code is 6142', batch = 200, common = 1000, holding = 3;
      const rows = await candidateRowsPage('notes/sweep-batch-rows', claim, common, holding);
      const id = await seed('notes/sweep-batch-purge', claim);
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      try {
        const receipt = await purge(id);
        const sweeps = derivationSweepStatements.filter(s => s.phase === 'sweep'), probes = derivationSweepStatements.filter(s => s.phase === 'probe');
        expect(Math.max(...sweeps.map(s => s.scanned))).toBe(batch);
        expect(sweeps.length).toBeGreaterThanOrEqual(Math.ceil((common + holding) / batch));
        expect(sweeps.slice(0, -1).every(s => s.scanned === batch) && sweeps.at(-1)!.scanned < batch).toBe(true);
        expect(sweeps.reduce((n, s) => n + s.normalized, 0)).toBeGreaterThanOrEqual(common + holding);
        expect(probes.slice(0, -1).every(s => s.scanned === batch) && probes.at(-1)!.scanned < batch).toBe(true);
        expect(probes.reduce((n, s) => n + s.normalized, 0)).toBeGreaterThanOrEqual(common);
        expect(await exactHolders(brain.engine, rows, claim)).toEqual([]);
        expect((await brain.engine.readSegmentDerivations(rows)).length).toBe(common);
        complete(receipt);
        expect(derivationStore(receipt)?.status).toBe('deleted');
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
    }, 600_000);

    /** Derivation rows of the source. */
    const sourceRows = async () => Number((await brain.engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM page_segment_derivations d JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1', [SOURCE]))[0]!.n);
    const sweepsRecorded = async () => Number((await brain.engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM page_segment_derivation_purges WHERE source_id=$1', [SOURCE]))[0]!.n);
    const sweepStatements = () => derivationSweepStatements.filter(s => s.phase === 'sweep');
    const confirmed = async (id: number) => {
      const dry = await brain.call('purge_fact', { id, dry_run: true });
      return { id, confirm: dry.body.confirm_token, expected_revision: dry.body.expected_revision, request_id: randomUUID() };
    };

    test('a large source\'s sweep resumes from its cursor on each replay and completes with no residual', async () => {
      const claim = 'Purge Example vent code is 8350', batch = 200, holding = 3;
      const rows = await candidateRowsPage('notes/sweep-budget-rows', claim, 600, holding);
      const id = await seed('notes/sweep-budget-purge', claim);
      const params = await confirmed(id);
      __setDerivationSweepLimitsForTests({ batchRows: batch, totalMs: 0 });
      __setDerivationSweepWorkForTests(true);
      try {
        const first = await brain.call('purge_fact', params);
        expect({ isError: first.isError, state: first.body.state, completion: first.body.completion, sweep: first.body.derivation_sweep, store: derivationStore(first.body)?.status })
          .toEqual({ isError: false, state: 'committed', completion: 'incomplete', sweep: 'pending', store: 'incomplete' });
        expect(sweepStatements().map(s => s.scanned)).toEqual([batch]);
        const [fact] = await brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id=$1', [id]);
        expect(Number(fact!.n)).toBe(0);
        let last = first, calls = 1;
        while (last.body.derivation_sweep === 'pending' && calls < 1000) {
          last = await brain.call('purge_fact', params);
          calls++;
        }
        const sweeps = sweepStatements();
        expect(calls).toBeGreaterThan(2);
        expect(sweeps.length).toBe(calls);
        expect(sweeps.slice(0, -1).every(s => s.scanned === batch) && sweeps.at(-1)!.scanned < batch).toBe(true);
        expect(sweeps.reduce((n, s) => n + s.scanned, 0)).toBe(await sourceRows() + derivationSweepWork.reduce((n, w) => n + w.deleted, 0));
        expect({ replayed: last.body.replayed, sweep: last.body.derivation_sweep }).toEqual({ replayed: true, sweep: undefined });
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect(await exactHolders(brain.engine, rows, claim)).toEqual([]);
      expect((await brain.engine.readSegmentDerivations(rows)).length).toBe(600);
      expect(await sweepsRecorded()).toBe(0);
    }, 600_000);

    test('a row holding the claim written behind the sweep\'s cursor while it walks is refused, and no residual is left', async () => {
      const claim = 'Purge Example latch code is 4471', batch = 100;
      const behind = await candidateRowsPage('notes/sweep-behind-early', claim, 0, 1);
      const rows = await candidateRowsPage('notes/sweep-behind-rows', claim, 300, 2);
      const id = await seed('notes/sweep-behind-purge', claim);
      const written: number[] = [];
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      __setAfterDerivationSweepBatchForTests(async () => {
        if (sweepStatements().at(-1)!.scanned < batch) return;
        written.push((await brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256,
            context_hash, state, output, receipt) VALUES ($1, 'links', $2, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done',
            jsonb_build_object('candidates', jsonb_build_array(jsonb_build_object('context', 'Late: ' || $3::text))), NULL)
          ON CONFLICT (page_id, pipeline, occurrence_id) DO UPDATE SET output = EXCLUDED.output RETURNING 1`, [behind, 1000 + written.length, claim])).length);
      });
      let receipt: Record<string, any>;
      try { receipt = await purge(id); } finally {
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect(written.length).toBeGreaterThan(1);
      expect({ written: written.reduce((n, k) => n + k, 0), behind: await exactHolders(brain.engine, behind, claim), rows: await exactHolders(brain.engine, rows, claim) })
        .toEqual({ written: 0, behind: [], rows: [] });
      complete(receipt!);
      expect(receipt!.derivation_sweep).toBeUndefined();
    }, 600_000);

    test('writes to other pages of the source commit while a sweep walks a large source', async () => {
      const claim = 'Purge Example dock code is 3920', batch = 100;
      const rows = await candidateRowsPage('notes/sweep-writer-rows', claim, 300, 1);
      const id = await seed('notes/sweep-writer-purge', claim);
      const results: Array<{ isError: boolean; code: unknown }> = [];
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      __setAfterDerivationSweepBatchForTests(async () => {
        const k = results.length;
        const res = await brain.call('put_page', { slug: `notes/sweep-writer-other-${k}`, content: `---\ntype: note\ntitle: Writer Example ${k}\n---\n\nWritten during the sweep.\n`,
          request_id: randomUUID() });
        results.push({ isError: res.isError, code: res.body.error ?? res.body.code ?? null });
      });
      let receipt: Record<string, any>, statements = 0;
      try { receipt = await purge(id); statements = sweepStatements().length; } finally {
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect(statements).toBeGreaterThan(3);
      expect({ writes: results.length, failed: results.filter(r => r.isError) }).toEqual({ writes: statements, failed: [] });
      const [pages] = await brain.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'notes/sweep-writer-other-%'", [SOURCE]);
      expect(Number(pages!.n)).toBe(statements);
      expect(await exactHolders(brain.engine, rows, claim)).toEqual([]);
      complete(receipt!);
    }, 600_000);

    test('a sweep call starts no batch past its deadline, also after the last short batch of a sweep', async () => {
      const claimA = 'Purge Example cellar code is 5307', claimB = 'Purge Example attic code is 6418';
      const rows = await candidateRowsPage('notes/sweep-deadline-rows', claimA, 300, 1);
      const a = await confirmed(await seed('notes/sweep-deadline-a', claimA));
      const idB = await seed('notes/sweep-deadline-b', claimB);
      try {
        __setDerivationSweepLimitsForTests({ batchRows: 100, totalMs: 0 });
        __setDerivationSweepWorkForTests(true);
        expect((await brain.call('purge_fact', a)).body.derivation_sweep).toBe('pending');
        expect(sweepStatements().map(s => s.scanned)).toEqual([100]);
        __setDerivationSweepLimitsForTests({ batchRows: 1_000_000, totalMs: 0 });
        __setDerivationSweepWorkForTests(true);
        const b = await purge(idB);
        const sweeps = sweepStatements();
        expect({ statements: sweeps.length, short: sweeps[0]!.scanned < 1_000_000, sweep: b.derivation_sweep, recorded: await sweepsRecorded() })
          .toEqual({ statements: 1, short: true, sweep: 'pending', recorded: 1 });
        expect(await exactHolders(brain.engine, rows, claimA)).toEqual([]);
        const replay = await brain.call('purge_fact', a);
        expect({ replayed: replay.body.replayed, sweep: replay.body.derivation_sweep, statements: sweepStatements().length, recorded: await sweepsRecorded() })
          .toEqual({ replayed: true, sweep: undefined, statements: 2, recorded: 0 });
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
    }, 600_000);

    test('a sweep statement reads at most batchRows rows of the source, rows outside its scope included', async () => {
      const claim = 'Purge Example porch code is 7084', batch = 10;
      await brain.seed('notes/sweep-bounded-live', prosePage('Alice Example keeps bees', 65));
      const live = await storedPage(brain.engine, 'notes/sweep-bounded-live');
      await deriveAll(brain.engine, live);
      const rows = await candidateRowsPage('notes/sweep-bounded-rows', claim, 120, 1);
      const id = await seed('notes/sweep-bounded-purge', claim);
      const outside = (await brain.engine.readSegmentDerivations(live.id)).length;
      expect(outside).toBeGreaterThan(batch);
      expect((await unbackedRows(brain.engine)).has(live.id)).toBe(false);
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      try {
        const receipt = await purge(id);
        const sweeps = sweepStatements();
        expect(sweeps.length).toBeGreaterThan(2);
        expect(sweeps.slice(0, -1).every(s => s.scanned === batch) && sweeps.at(-1)!.scanned < batch).toBe(true);
        expect(sweeps.reduce((n, s) => n + s.scanned, 0)).toBe(await sourceRows() + derivationSweepWork.reduce((n, w) => n + w.deleted, 0));
        expect(derivationSweepWork.find(w => w.pageId === live.id)).toBeUndefined();
        expect(await exactHolders(brain.engine, rows, claim)).toEqual([]);
        complete(receipt);
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
    }, 600_000);
  });
}
