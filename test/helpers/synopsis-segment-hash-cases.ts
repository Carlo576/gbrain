/**
 * Contextual synopsis per segment (wave-b spec 8.6, PR 4 lane 4c), shared by the PGLite arm
 * (test/large-pages/synopsis-segment-hash.test.ts) and the Postgres arm (test/e2e/synopsis-segment-hash-postgres.test.ts).
 * The synopsis model is a fake with a call counter (the service's generateSynopsis seam) and the embedder is the brain's
 * fake; no provider is called.
 *
 * 1. Protects: under per_chunk_synopsis a segmented page leaves the title tier: every live chunk gets a synopsis vector
 *    whose document is the title, the projected lead and one window of its own segment (within SYNOPSIS_DOC_MAX_CHARS),
 *    one synopsis derivation row per live occurrence. A rerun calls nothing and reads no chunk row. An append (by a
 *    remote writer) re-synopsizes only the chunks of the windows it changed: the rewritten tail segment's unchanged
 *    windows carry their synopsis vectors onto the new rows at staging, so calls equal the changed windows' chunks, one
 *    segment is read, and every other chunk keeps its embedding_input_hash and vector. An exhausted per-page cap leaves the page on the title tier
 *    with no synopsis call; with room, the same page takes the synopsis tier. A refused synopsis embeds its window at
 *    the title tier and settles. An inline page keeps the synopsisBodyHash input.
 * 2. Fails when: a segmented page never leaves the title tier (the pre-lane skip), the synopsis input is hashed over every
 *    chunk of the page (an append changes every chunk's input), the rewritten tail is re-synopsized whole (staging drops
 *    the synopsis vectors of its unchanged windows), a settled segment is read or paid for again, or a refused
 *    reservation still calls the model.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { reembedPageWithContextualRetrieval } from '../../src/core/contextual-retrieval-service.ts';
import { SYNOPSIS_DOC_MAX_CHARS, segmentSynopsisWindows, type GeneratePerChunkSynopsisArgs, type GeneratePerChunkSynopsisResult } from '../../src/core/page-summary.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import { segmentSynopsisLead } from '../../src/core/page-body/segment-synopsis.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { chunkGenerationFilter } from '../../src/core/search/safe-chunks.ts';
import type { AppendBrain } from './append-brain.ts';

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer'];
const paragraph = (d: number, k: number) =>
  [`day${d}`, `para${k}`, ...Array.from({ length: 98 }, (_, i) => WORDS[(d * 7 + k * 3 + i) % WORDS.length])].join(' ') + '.';
export const day = (d: number) => `## Day ${d}\n\n${[1, 2, 3, 4].map(k => paragraph(d, k)).join('\n\n')}\n\n`;
export const TITLE = 'Daily log';
export const LEAD = 'Opening note: this log tracks the acme-example launch.';
const page = (body: string) => `---\ntitle: ${TITLE}\ntype: note\n---\n\n${LEAD}\n\n${body}`;
function days(bytes: number): { body: string; count: number } {
  let body = '';
  let count = 0;
  while (Buffer.byteLength(body) < bytes) body += day(++count);
  return { body, count };
}

interface ChunkRow { chunk_index: number; chunk_text: string; chunk_source: string; occurrence_id: number | null; embedding_input_hash: string | null; vector: string | null }

/** The service's segment chunk read (listSegmentChunkRows); counted to prove a settled segment is never read. */
const SEGMENT_CHUNK_READ = 'cc.occurrence_id = $2';

export function defineSynopsisSegmentHashCases(opts: { getBrain: () => AppendBrain }): void {
  const calls: GeneratePerChunkSynopsisArgs[] = [];
  let segmentReads = 0;
  let refuse: ((args: GeneratePerChunkSynopsisArgs) => boolean) | null = null;
  const generateSynopsis = async (args: GeneratePerChunkSynopsisArgs): Promise<GeneratePerChunkSynopsisResult> => {
    calls.push(args);
    if (refuse?.(args)) return { kind: 'refusal', detail: 'fixture refusal' };
    return { kind: 'success', synopsis: `Synopsis of chunk ${args.chunkIndex}.` };
  };
  const counting = (engine: BrainEngine): BrainEngine => new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => { if (sql.includes(SEGMENT_CHUNK_READ)) segmentReads++; return target.executeRaw(sql, params); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const reset = () => { calls.length = 0; segmentReads = 0; opts.getBrain().embedded.length = 0; };
  const run = (slug: string, globalMode: 'per_chunk_synopsis' | 'title' | 'none' = 'per_chunk_synopsis') =>
    reembedPageWithContextualRetrieval({ engine: counting(opts.getBrain().engine), pageSlug: slug, sourceId: 'default', globalMode, generateSynopsis, chunkConcurrency: 4 });
  const chunks = async (slug: string): Promise<ChunkRow[]> => (await opts.getBrain().engine.executeRaw<ChunkRow>(
    `SELECT c.chunk_index, c.chunk_text, c.chunk_source, c.occurrence_id, c.embedding_input_hash, c.embedding::text AS vector
       FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE p.source_id = 'default' AND p.slug = $1 AND ${chunkGenerationFilter('p', 'c')} ORDER BY c.chunk_index`, [slug]))
    .map(row => ({ ...row, chunk_index: Number(row.chunk_index), occurrence_id: row.occurrence_id === null ? null : Number(row.occurrence_id) }));
  const pageRow = async (slug: string) => (await opts.getBrain().engine.executeRaw<{ id: number; mode: string | null; generation: string | null; body_storage: string }>(
    "SELECT id, contextual_retrieval_mode AS mode, corpus_generation AS generation, body_storage FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))
    .map(row => ({ ...row, id: Number(row.id) }))[0]!;
  const titleHash = async (c: ChunkRow) => embeddingInputHash(embeddingInputContext(await embeddingWriteTarget(opts.getBrain().engine), TITLE, null, []), 'title', c);
  const synopsisRows = async (pageId: number) => opts.getBrain().engine.readSegmentDerivations(pageId, { kind: 'synopsis' });
  const nonCode = (rows: ChunkRow[]) => rows.filter(c => c.chunk_source !== 'fenced_code');
  /** The cap is set high enough for a whole 2.3 MB page at the upper-bound estimate (uncached prompts at list price). */
  const roomyCap = () => opts.getBrain().engine.setConfig(PAGE_EMBED_CAP_KEY, '1000');

  test('append invalidation: a segmented page leaves the title tier, a rerun does no work, an append pays only for the windows it changed', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-log';
    const { body, count } = days(2_300_000);
    await brain.seed(slug, page(body));
    const seeded = await pageRow(slug);
    expect(seeded.body_storage).toBe('segmented');
    const before = await chunks(slug);
    const occurrences = new Set(before.map(c => c.occurrence_id));
    expect(occurrences.size).toBeGreaterThan(1);

    reset();
    const first = await run(slug);
    expect(first).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: before.length });
    expect(calls.length).toBe(nonCode(before).length);
    expect(brain.embedded.length).toBe(before.length);
    expect(segmentReads).toBe(occurrences.size);
    for (const call of calls) {
      expect(call.documentText.length).toBeLessThanOrEqual(SYNOPSIS_DOC_MAX_CHARS);
      expect(call.documentText.startsWith(LEAD)).toBe(true);
      expect(call.documentText).toContain(call.chunkText);
    }
    expect(brain.embedded.every(text => text.includes('Synopsis of chunk'))).toBe(true);
    expect(await pageRow(slug)).toMatchObject({ mode: 'per_chunk_synopsis', generation: first.kind === 'success' ? first.corpus_generation : 'unset' });
    const done = await chunks(slug);
    expect(done.every(c => c.vector !== null)).toBe(true);
    for (const c of done) expect(c.embedding_input_hash).not.toBe(await titleHash(c));
    const rows = await synopsisRows(seeded.id);
    expect(rows.map(r => r.occurrenceId).sort()).toEqual([...occurrences].map(Number).sort());
    expect(rows.every(r => r.state === 'done')).toBe(true);

    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
    expect({ calls: calls.length, embedded: brain.embedded.length, segmentReads }).toEqual({ calls: 0, embedded: 0, segmentReads: 0 });

    const appended = await brain.call('append_page', { slug, text: day(count + 1), request_id: randomUUID() }, { remote: true });
    expect(appended.isError).toBe(false);
    const after = await chunks(slug);
    const fresh = after.filter(c => !occurrences.has(c.occurrence_id));
    const freshOccurrences = new Set(fresh.map(c => c.occurrence_id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.length).toBeLessThan(after.length / 2);
    const kept = new Map(done.map(c => [c.chunk_index, c]));
    for (const c of after.filter(row => occurrences.has(row.occurrence_id))) {
      expect(c.embedding_input_hash).toBe(kept.get(c.chunk_index)!.embedding_input_hash);
      expect(c.vector).toBe(kept.get(c.chunk_index)!.vector);
    }
    // The changed windows, from the window documents alone: a fresh chunk whose (document, text) no retired window had.
    const lead = await segmentSynopsisLead(brain.engine, { id: seeded.id, slug, source_id: 'default' });
    const retired = done.filter(c => !after.some(a => a.occurrence_id === c.occurrence_id));
    const oldInputs = new Map<string, ChunkRow>();
    for (const w of segmentSynopsisWindows(retired, lead)) for (const c of w.chunks) oldInputs.set(`${w.document}\0${c.chunk_text}`, c);
    const changed: number[] = [];
    const carried: Array<[ChunkRow, ChunkRow]> = [];
    for (const w of segmentSynopsisWindows(fresh, lead)) {
      for (const c of w.chunks) {
        const old = oldInputs.get(`${w.document}\0${c.chunk_text}`);
        if (old) carried.push([c, old]); else if (c.chunk_source !== 'fenced_code') changed.push(c.chunk_index);
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(fresh.length / 2);
    expect(carried.length).toBe(fresh.length - changed.length);
    for (const [c, old] of carried) {
      expect(c.embedding_input_hash).toBe(old.embedding_input_hash);
      expect(c.vector).toBe(old.vector);
    }

    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: changed.length });
    expect(calls.map(call => call.chunkIndex).sort((a, b) => a - b)).toEqual(changed);
    expect(segmentReads).toBe(freshOccurrences.size);
    for (const [c] of carried) expect((await chunks(slug)).find(row => row.chunk_index === c.chunk_index)!.embedding_input_hash).toBe(c.embedding_input_hash);
    expect(calls.some(call => call.documentText.includes(`## Day ${count + 1}`))).toBe(true);
    const settled = await synopsisRows(seeded.id);
    expect(new Set(settled.map(r => r.occurrenceId))).toEqual(new Set(after.map(c => c.occurrence_id!)));
    expect((await chunks(slug)).every(c => c.vector !== null)).toBe(true);
  }, 600_000);

  test('cap: an exhausted per-page cap keeps the title tier with no synopsis call; with room the page takes the synopsis tier', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-capped';
    await brain.seed(slug, page(days(1_300_000).body));
    const { id } = await pageRow(slug);
    await brain.engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, cap_usd, spent_usd) VALUES ($1, 1, 1)
      ON CONFLICT (page_id) DO UPDATE SET cap_usd = 1, spent_usd = 1`, [id]);
    const before = await pageRow(slug);
    reset();
    expect(await run(slug)).toEqual({ kind: 'skipped', reason: 'budget_limited' });
    expect({ calls: calls.length, embedded: brain.embedded.length }).toEqual({ calls: 0, embedded: 0 });
    expect(await pageRow(slug)).toEqual(before);
    expect((await chunks(slug)).some(c => c.vector !== null)).toBe(false);

    await brain.engine.executeRaw('UPDATE page_embedding_budget SET cap_usd = 1000 WHERE page_id = $1', [id]);
    reset();
    const all = await chunks(slug);
    expect(await run(slug)).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: all.length });
    expect(calls.length).toBe(nonCode(all).length);
    expect((await pageRow(slug)).mode).toBe('per_chunk_synopsis');
  }, 300_000);

  test('a refused synopsis embeds its window at the title tier and settles; title and none stay with the segmented embedding path', async () => {
    const brain = opts.getBrain();
    await roomyCap();
    const slug = 'notes/synopsis-refused';
    await brain.seed(slug, page(days(1_300_000).body + '\nRefusal fixture.\n'));
    for (const mode of ['title', 'none'] as const) expect(await run(slug, mode)).toEqual({ kind: 'skipped', reason: 'page_body_segmented' });
    const all = await chunks(slug);
    const refused = all[Math.floor(all.length / 2)]!;
    refuse = args => args.chunkIndex === refused.chunk_index;
    try {
      expect(await run(slug)).toMatchObject({ kind: 'page_fallback', mode_applied: 'per_chunk_synopsis', fallback_kind: 'refusal', chunks_embedded: all.length });
    } finally {
      refuse = null;
    }
    const after = await chunks(slug);
    const titled: number[] = [];
    for (const c of after) if (c.embedding_input_hash === await titleHash(c)) titled.push(c.chunk_index);
    expect(titled).toContain(refused.chunk_index);
    expect(titled.length).toBeLessThan(after.length);
    expect(after.every(c => c.vector !== null)).toBe(true);
    const rows = await synopsisRows((await pageRow(slug)).id);
    expect(rows.find(r => r.occurrenceId === refused.occurrence_id)).toMatchObject({ state: 'done', receipt: { fallback_kind: 'refusal' } });
    reset();
    expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
    expect(calls.length).toBe(0);
  }, 300_000);

  test('an inline page keeps the synopsisBodyHash input', async () => {
    const brain = opts.getBrain();
    const slug = 'notes/synopsis-inline';
    await brain.seed(slug, page(days(40_000).body));
    expect((await pageRow(slug)).body_storage).toBe('inline');
    reset();
    const result = await run(slug);
    expect(result).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis' });
    const stored = await chunks(slug);
    const provenance = embeddingInputContext(await embeddingWriteTarget(brain.engine), TITLE, result.kind === 'success' ? result.corpus_generation : null, stored);
    for (const c of stored) expect(c.embedding_input_hash).toBe(embeddingInputHash(provenance, 'per_chunk_synopsis', c));
    expect(calls.every(call => call.documentText === stored.filter(c => c.chunk_source !== 'image_asset').map(c => c.chunk_text).join('\n\n'))).toBe(true);
  }, 300_000);
}
