/**
 * #3985 — expose `types?: string[]` on the public search + query ops.
 *
 * The SQL-level plumbing (SearchOpts.types → both engines' keyword / title /
 * vector legs) has existed since v0.33 for whoknows; pre-fix the search and
 * query ops simply never accepted the param, so MCP/CLI callers could not
 * type-scope retrieval. Pins: param reaches the engine on both ops, CLI
 * comma-string form works, junk is rejected as invalid_params.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const searchOp = operations.find((o) => o.name === 'search')!;
const queryOp = operations.find((o) => o.name === 'query')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: console as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages: Array<[slug: string, type: string]> = [
    ['people/alice-example', 'person'],
    ['companies/acme-example', 'company'],
    ['notes/telescope-note', 'note'],
  ];
  for (const [slug, type] of pages) {
    await engine.putPage(slug, {
      type,
      title: `Zebra telescope ${type}`,
      compiled_truth: `the zebra telescope appears in this ${type} page`,
      frontmatter: {},
    });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: `the zebra telescope appears in this ${type} page`, chunk_source: 'compiled_truth' },
    ]);
  }
  await engine.putPage('analysis/research-example', {
    type: 'analysis',
    title: 'Legacy research example',
    compiled_truth: 'legacy telescope evidence appears here',
    frontmatter: { legacy_type: 'research' },
  });
  await engine.upsertChunks('analysis/research-example', [
    { chunk_index: 0, chunk_text: 'legacy telescope evidence appears here', chunk_source: 'compiled_truth' },
  ]);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'team-b') ON CONFLICT (id) DO NOTHING`);
  await engine.putPage('analysis/team-b-research', {
    type: 'analysis', title: 'Team B research', compiled_truth: 'team-b legacy telescope evidence',
    frontmatter: { legacy_type: 'research' },
  }, { sourceId: 'team-b' });
  await engine.upsertChunks('analysis/team-b-research', [
    { chunk_index: 0, chunk_text: 'team-b legacy telescope evidence', chunk_source: 'compiled_truth' },
  ], { sourceId: 'team-b' });
  // Keyword-only path for the search op: no embedding provider needed.
  await engine.setConfig('search.mcp_keyword_only', 'true');
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

function slugsOf(results: unknown): string[] {
  return (results as SearchResult[]).map((r) => r.slug).sort();
}

describe('search op — types param (#3985)', () => {
  test('no types → all matching pages (baseline)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'zebra telescope' });
    expect(slugsOf(out)).toEqual(['companies/acme-example', 'notes/telescope-note', 'people/alice-example']);
  });

  test('types array filters at SQL level', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'zebra telescope', types: ['person'] });
    expect(slugsOf(out)).toEqual(['people/alice-example']);
  });

  test('CLI comma-string form works (--types person,company)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'zebra telescope', types: 'person,company' });
    expect(slugsOf(out)).toEqual(['companies/acme-example', 'people/alice-example']);
  });

  test('legacy alias filter reaches canonical rows through legacy_type', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base-v2' }, async () => {
      const out = await searchOp.handler(ctxOf(), { query: 'legacy telescope', types: ['research'] });
      expect(slugsOf(out)).toEqual(['analysis/research-example']);
    });
  });

  test('source_id override resolves that source pack before expanding types', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base');
    await engine.setConfig('schema_pack.source.team-b', 'gbrain-base-v2');
    try {
      const out = await searchOp.handler(ctxOf(), {
        query: 'team-b legacy telescope', source_id: 'team-b', types: ['research'],
      });
      expect(slugsOf(out)).toEqual(['analysis/team-b-research']);
    } finally {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
    }
  });

  test('federated type filters reject divergent source packs', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base');
    await engine.setConfig('schema_pack.source.team-b', 'gbrain-base-v2');
    try {
      await expect(searchOp.handler(ctxOf(), {
        query: 'legacy telescope', source_id: '__all__', types: ['research'],
      })).rejects.toThrow(/divergent schema packs/i);
    } finally {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
    }
  });

  test('non-string entries reject loudly as invalid_params', async () => {
    await expect(
      searchOp.handler(ctxOf(), { query: 'zebra telescope', types: [42] }),
    ).rejects.toThrow(/types.*must be an array/i);
  });

  test('all-empty list rejects loudly instead of silently dropping the filter', async () => {
    await expect(
      searchOp.handler(ctxOf(), { query: 'zebra telescope', types: ' , ' }),
    ).rejects.toThrow(/no usable page-type/i);
  });

  test('oversized type arrays reject before SQL expansion', async () => {
    const types = Array.from({ length: 65 }, (_, i) => `type-${i}`);
    await expect(
      searchOp.handler(ctxOf(), { query: 'zebra telescope', types }),
    ).rejects.toThrow(/at most 64/i);
  });
});

describe('query op — types param (#3985)', () => {
  test('types filter applies on the no-provider hybrid path', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), {
        query: 'zebra telescope',
        expand: false,
        types: ['company'],
      });
      expect(slugsOf(out)).toEqual(['companies/acme-example']);
    });
  });

  test('query without types keeps full recall', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), { query: 'zebra telescope', expand: false });
      expect(slugsOf(out)).toEqual(['companies/acme-example', 'notes/telescope-note', 'people/alice-example']);
    });
  });

  test('query legacy alias filter reaches canonical rows on every retrieval leg', async () => {
    await withEnv({ OPENAI_API_KEY: undefined, GBRAIN_SCHEMA_PACK: 'gbrain-base-v2' }, async () => {
      const out = await queryOp.handler(ctxOf(), {
        query: 'legacy telescope', expand: false, types: ['research'],
      });
      expect(slugsOf(out)).toEqual(['analysis/research-example']);
    });
  });

  test('junk types reject before any retrieval work', async () => {
    await expect(
      queryOp.handler(ctxOf(), { query: 'zebra telescope', types: { person: true } }),
    ).rejects.toThrow(/types.*must be an array/i);
  });
});
