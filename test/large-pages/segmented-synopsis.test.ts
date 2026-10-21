/**
 * Contextual synopsis per segment on a segmented page (wave-b spec 8.6, PR 4 lane 4c).
 *
 * 1. Protects: reembedPageWithContextualRetrieval on a segmented page whose resolved mode is per_chunk_synopsis
 *    gives every live chunk a synopsis vector whose document is the title, the first 8 KiB of the projected lead and
 *    one window of its own segment (never more than SYNOPSIS_DOC_MAX_CHARS, never the rest of the body); its recorded
 *    input names that document, so a rerun calls nothing and an append pays only for the chunks of its new segments,
 *    while the vectors of unchanged segments keep their recorded inputs. Each window reserves against the per-page
 *    spend cap first: a cap that admits nothing leaves the page as it was (budget_limited). A refused synopsis embeds
 *    its window at the title tier (page_fallback). Title and none stay with the segmented embedding path.
 * 2. Fails when: the segmented page is skipped as page_body_segmented under per_chunk_synopsis (the title-tier forcing
 *    never lifts), the synopsis input is hashed over every chunk of the page (an append re-synopsizes the whole page),
 *    the document is cut by buildPagePrompt, or a synopsis call runs past a refused reservation.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The synopsis model and the embedding provider are fakes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { reembedPageWithContextualRetrieval } from '../../src/core/contextual-retrieval-service.ts';
import { SYNOPSIS_DOC_MAX_CHARS, SEGMENT_SYNOPSIS_LEAD_BYTES, SEGMENT_SYNOPSIS_WINDOW_BYTES, segmentSynopsisWindows, type GeneratePerChunkSynopsisArgs, type GeneratePerChunkSynopsisResult } from '../../src/core/page-summary.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { chunkGenerationFilter } from '../../src/core/search/safe-chunks.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer'];
const paragraph = (day: number, k: number) =>
  [`day${day}`, `para${k}`, ...Array.from({ length: 98 }, (_, i) => WORDS[(day * 7 + k * 3 + i) % WORDS.length])].join(' ') + '.';
const day = (d: number) => `## Day ${d}\n\n${[1, 2, 3, 4].map(k => paragraph(d, k)).join('\n\n')}\n\n`;
const TITLE = 'Daily log';
const LEAD = 'Opening note: this log tracks the launch.';
const page = (body: string) => `---\ntitle: ${TITLE}\ntype: note\n---\n\n${LEAD}\n\n${body}`;
function days(bytes: number): { body: string; count: number } {
  let body = '';
  let count = 0;
  while (Buffer.byteLength(body) < bytes) body += day(++count);
  return { body, count };
}

interface ChunkRow { chunk_index: number; chunk_text: string; chunk_source: string; occurrence_id: number; embedding_input_hash: string | null; embedded: boolean }

describe('segmentSynopsisWindows (pure)', () => {
  test('packs a segment\'s chunks in order into windows the prompt never cuts; each chunk in exactly one window', () => {
    const lead = 'Lead paragraph. '.repeat(400);
    const rows = Array.from({ length: 40 }, (_, i) => ({ chunk_index: i, chunk_text: `chunk ${i} `.repeat(300), chunk_source: i === 7 ? 'image_asset' : 'compiled_truth' }));
    rows.push({ chunk_index: 40, chunk_text: 'x'.repeat(SEGMENT_SYNOPSIS_WINDOW_BYTES + 10), chunk_source: 'compiled_truth' });
    const windows = segmentSynopsisWindows(rows, lead);
    expect(windows.flatMap(w => w.chunks.map(c => c.chunk_index))).toEqual(rows.filter(r => r.chunk_source !== 'image_asset').map(r => r.chunk_index));
    expect(windows.at(-1)!.chunks.map(c => c.chunk_index)).toEqual([40]);
    for (const w of windows.slice(0, -1)) {
      expect(w.document.length).toBeLessThanOrEqual(SYNOPSIS_DOC_MAX_CHARS);
      expect(w.document.startsWith(lead)).toBe(true);
      expect(Buffer.byteLength(w.document) - Buffer.byteLength(lead)).toBeLessThanOrEqual(SEGMENT_SYNOPSIS_WINDOW_BYTES + 16);
      for (const c of w.chunks) expect(w.document).toContain(c.chunk_text);
    }
    expect(windows.length).toBeGreaterThan(2);
    expect(segmentSynopsisWindows(rows.slice(0, 3), '')[0]!.document).toBe(rows.slice(0, 3).map(r => r.chunk_text).join('\n\n'));
  });
});

for (const kind of testBackends()) {
  describe(`segmented per-chunk synopsis (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const embedded: string[] = [];
    const calls: GeneratePerChunkSynopsisArgs[] = [];
    let refuseChunk: ((args: GeneratePerChunkSynopsisArgs) => boolean) | null = null;
    const generateSynopsis = async (args: GeneratePerChunkSynopsisArgs): Promise<GeneratePerChunkSynopsisResult> => {
      calls.push(args);
      if (refuseChunk?.(args)) return { kind: 'refusal', detail: 'test refusal' };
      return { kind: 'success', synopsis: `Synopsis of chunk ${args.chunkIndex}.` };
    };
    const run = (slug: string, globalMode: 'per_chunk_synopsis' | 'title' | 'none' = 'per_chunk_synopsis') =>
      reembedPageWithContextualRetrieval({ engine, pageSlug: slug, sourceId: 'default', globalMode, generateSynopsis, chunkConcurrency: 4 });
    const chunks = async (slug: string): Promise<ChunkRow[]> => (await engine.executeRaw<ChunkRow>(
      `SELECT c.chunk_index, c.chunk_text, c.chunk_source, c.occurrence_id, c.embedding_input_hash, c.embedding IS NOT NULL AS embedded
         FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.slug = $1 AND ${chunkGenerationFilter('p', 'c')} ORDER BY c.chunk_index`, [slug]))
      .map(row => ({ ...row, chunk_index: Number(row.chunk_index), occurrence_id: Number(row.occurrence_id) }));
    const stamp = async (slug: string) => (await engine.executeRaw<{ mode: string | null; generation: string | null; body_storage: string }>(
      'SELECT contextual_retrieval_mode AS mode, corpus_generation AS generation, body_storage FROM pages WHERE slug = $1', [slug]))[0]!;
    const titleHash = async (c: ChunkRow) => embeddingInputHash(embeddingInputContext(await embeddingWriteTarget(engine), TITLE, null, []), 'title', c);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      const dims = (await resolveActiveEmbeddingColumnFromEngine(engine)).dimensions;
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.setConfig('embed.max_usd_per_page', '1000');
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        embedded.push(...values);
        return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
      }) as never);
    }, 120_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test('every chunk gets a synopsis over its own segment window; a rerun calls nothing; an append pays only for its new segments', async () => {
      const slug = 'notes/synopsis-log';
      const { body, count } = days(2_300_000);
      await importFromContent(engine, slug, page(body), { noEmbed: true });
      expect((await stamp(slug)).body_storage).toBe('segmented');
      const before = await chunks(slug);
      expect(new Set(before.map(c => c.occurrence_id)).size).toBeGreaterThan(1);

      calls.length = 0; embedded.length = 0;
      const first = await run(slug);
      expect(first).toMatchObject({ kind: 'success', mode_applied: 'per_chunk_synopsis', chunks_embedded: before.length });
      expect(calls.length).toBe(before.filter(c => c.chunk_source !== 'fenced_code').length);
      expect(embedded.length).toBe(before.length);
      for (const call of calls) {
        expect(call.documentText.length).toBeLessThanOrEqual(SYNOPSIS_DOC_MAX_CHARS);
        expect(call.documentText.startsWith(LEAD)).toBe(true);
        expect(call.documentText).toContain(call.chunkText);
        expect(Buffer.byteLength(call.documentText)).toBeLessThan(SEGMENT_SYNOPSIS_LEAD_BYTES + SEGMENT_SYNOPSIS_WINDOW_BYTES + 64);
      }
      expect(embedded.every(text => text.includes('Synopsis of chunk'))).toBe(true);
      expect(await stamp(slug)).toMatchObject({ mode: 'per_chunk_synopsis', generation: first.kind === 'success' ? first.corpus_generation : 'unset' });
      const done = await chunks(slug);
      expect(done.every(c => c.embedded && c.embedding_input_hash !== null)).toBe(true);
      for (const c of done) expect(c.embedding_input_hash).not.toBe(await titleHash(c));

      calls.length = 0; embedded.length = 0;
      expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: 0 });
      expect(calls.length).toBe(0);
      expect(embedded.length).toBe(0);

      await importFromContent(engine, slug, page(body + day(count + 1)), { noEmbed: true });
      const appended = await chunks(slug);
      const oldOccurrences = new Set(done.map(c => c.occurrence_id));
      const fresh = appended.filter(c => !oldOccurrences.has(c.occurrence_id));
      expect(fresh.length).toBeGreaterThan(0);
      expect(fresh.length).toBeLessThan(appended.length / 2);
      const kept = new Map(done.map(c => [c.chunk_index, c.embedding_input_hash]));
      for (const c of appended.filter(row => oldOccurrences.has(row.occurrence_id))) expect(c.embedding_input_hash).toBe(kept.get(c.chunk_index)!);

      calls.length = 0; embedded.length = 0;
      expect(await run(slug)).toMatchObject({ kind: 'success', chunks_embedded: fresh.length });
      expect(calls.map(call => call.chunkIndex).sort((a, b) => a - b)).toEqual(fresh.filter(c => c.chunk_source !== 'fenced_code').map(c => c.chunk_index));
      expect(calls.some(call => call.documentText.includes(`## Day ${count + 1}`))).toBe(true);
      expect((await chunks(slug)).every(c => c.embedded)).toBe(true);
    }, 600_000);

    test('a per-page cap that admits nothing calls no model and leaves the page as it was', async () => {
      const slug = 'notes/synopsis-capped';
      await importFromContent(engine, slug, page(days(1_300_000).body), { noEmbed: true });
      const pageId = Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]))[0]!.id);
      await engine.executeRaw('INSERT INTO page_embedding_budget (page_id, cap_usd) VALUES ($1, 0.0000001) ON CONFLICT (page_id) DO UPDATE SET cap_usd = EXCLUDED.cap_usd', [pageId]);
      const before = await stamp(slug);
      calls.length = 0; embedded.length = 0;
      expect(await run(slug)).toEqual({ kind: 'skipped', reason: 'budget_limited' });
      expect(calls.length).toBe(0);
      expect(embedded.length).toBe(0);
      expect(await stamp(slug)).toEqual(before);
      expect((await chunks(slug)).some(c => c.embedded)).toBe(false);
    }, 300_000);

    test('a refused synopsis embeds its window at the title tier; title and none modes stay with the segmented embedding path', async () => {
      const slug = 'notes/synopsis-refused';
      await importFromContent(engine, slug, page(days(1_300_000).body), { noEmbed: true });
      for (const mode of ['title', 'none'] as const) expect(await run(slug, mode)).toEqual({ kind: 'skipped', reason: 'page_body_segmented' });
      const all = await chunks(slug);
      const refused = all[Math.floor(all.length / 2)]!;
      refuseChunk = args => args.chunkIndex === refused.chunk_index;
      try {
        expect(await run(slug)).toMatchObject({ kind: 'page_fallback', mode_applied: 'per_chunk_synopsis', fallback_kind: 'refusal', chunks_embedded: all.length });
      } finally {
        refuseChunk = null;
      }
      const after = await chunks(slug);
      const titled: number[] = [];
      for (const c of after) if (c.embedding_input_hash === await titleHash(c)) titled.push(c.chunk_index);
      expect(titled).toContain(refused.chunk_index);
      expect(titled.length).toBeLessThan(after.length);
      expect(after.every(c => c.embedded)).toBe(true);
    }, 300_000);
  });
}
