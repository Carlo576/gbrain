/**
 * reservePageSpend (wave-b spec 8.3, PR 4 lane 4b): every paid step on a segmented page reserves against the page's
 * one lifetime cap in page_embedding_budget, the kind carried in the signature.
 *
 * 1. Protects: two kinds share one cap; a reservation over what the cap leaves refuses before the (fake) provider call
 *    and reserves nothing; a failed call releases its reservation; only a new embedding model starts a new ledger;
 *    inline pages under the large-page threshold are unmetered; the embedding planner sees derivation spend.
 * 2. Fails when: a kind gets its own budget, a refusal still runs the call or books spend, a facts model change
 *    forgives spend, or planPageEmbedding grants past spend another kind already booked.
 * 3. Why existing coverage misses it: page_embedding_budget was metered only by the embedding planner.
 * PGLite always; Postgres too when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_EMBED_CAP_KEY, planPageEmbedding, reservePageSpend, spendGrant, type PageSpendSignature } from '../src/core/page-embedding-budget.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ name: 'postgres', engine: pg.engine });
    closePostgres = pg.close;
  }
  for (const { engine } of engines) await engine.setConfig(PAGE_EMBED_CAP_KEY, '1');
}, 120_000);

afterAll(async () => {
  for (const { name, engine } of engines) if (name === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

/** A stored page row standing in for a segmented page of `bytes` (the ledger reads only its id and shape). */
async function segmentedPage(engine: BrainEngine, bytes = 40 * 1024 * 1024) {
  const slug = `conversations/spend-${randomUUID().slice(0, 8)}`;
  await engine.putPage(slug, { type: 'conversation', title: 'Spend probe', compiled_truth: 'body' });
  const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'", [slug]);
  return { id: Number(row!.id), body_storage: 'segmented' as const, body_bytes: bytes };
}

async function ledger(engine: BrainEngine, pageId: number) {
  const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number; embedding_signature: string | null }>(
    'SELECT spent_usd, reserved_usd, embedding_signature FROM page_embedding_budget WHERE page_id = $1', [pageId]);
  return row ? { spent: Number(row.spent_usd), reserved: Number(row.reserved_usd), signature: row.embedding_signature } : null;
}

/** One fake paid call under a reservation: the call runs only on a grant. */
async function paidStep(engine: BrainEngine, page: Awaited<ReturnType<typeof segmentedPage>>, signature: PageSpendSignature, usd: number,
  calls: { n: number }, fail = false) {
  const decision = await reservePageSpend(engine, page, signature, usd);
  if (decision.kind === 'refused') return decision;
  await spendGrant(decision.kind === 'grant' ? decision.grant : undefined, async () => {
    calls.n++;
    if (fail) throw new Error('provider failed');
  }).catch(error => { if (!fail) throw error; });
  return decision;
}

describe('reservePageSpend', () => {
  test('two kinds share one per-page cap; a reservation over it refuses before the call and books nothing', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      expect((await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.6, calls)).kind, name).toBe('grant');
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.6, reserved: 0, signature: null });
      const refused = await paidStep(engine, page, 'atoms:anthropic:claude-haiku-5-5', 0.5, calls);
      expect(refused, name).toEqual({ kind: 'refused', reason: 'cap_reached', capUsd: 1, spentUsd: 0.6, reservedUsd: 0, estimateUsd: 0.5 });
      expect(calls.n, name).toBe(1);
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.6, reserved: 0, signature: null });
      expect((await paidStep(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.4, calls)).kind, name).toBe('grant');
      expect(calls.n, name).toBe(2);
      expect(await ledger(engine, page.id), name).toEqual({ spent: 1, reserved: 0, signature: 'openai:text-embedding-3-large:1536' });
      expect((await paidStep(engine, page, 'synopsis:anthropic:claude-haiku-5-5', 0.01, calls)).kind, name).toBe('refused');
      expect(calls.n, name).toBe(2);
    }
  });

  test('an open reservation counts against the cap until it settles; a failed call releases it', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const first = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.7);
      expect(first.kind, name).toBe('grant');
      expect((await reservePageSpend(engine, page, 'atoms:anthropic:claude-haiku-5-5', 0.4)).kind, name).toBe('refused');
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0, reserved: 0.7, signature: null });
      if (first.kind === 'grant') await first.grant.settle({ ok: false });
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0, reserved: 0, signature: null });
      const calls = { n: 0 };
      expect((await paidStep(engine, page, 'atoms:anthropic:claude-haiku-5-5', 0.4, calls, true)).kind, name).toBe('grant');
      expect(calls.n, name).toBe(1);
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0, reserved: 0, signature: null });
    }
  });

  test('only a new embedding model starts a new ledger; a facts model change keeps the spend', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      await paidStep(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.5, calls);
      await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.3, calls);
      expect((await paidStep(engine, page, 'facts:openai:gpt-6-luna', 0.3, calls)).kind, name).toBe('refused');
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.8, reserved: 0, signature: 'openai:text-embedding-3-large:1536' });
      expect((await paidStep(engine, page, 'embedding:voyage:voyage-4:1024', 0.3, calls)).kind, name).toBe('grant');
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.3, reserved: 0, signature: 'voyage:voyage-4:1024' });
      expect(calls.n, name).toBe(3);
    }
  });

  test('a small inline page is unmetered and leaves no ledger row', async () => {
    for (const { name, engine } of engines) {
      const page = { id: (await segmentedPage(engine)).id, body_storage: 'inline' as const, compiled_truth: 'short', timeline: '' };
      expect(await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 50), name).toEqual({ kind: 'unmetered' });
      expect(await ledger(engine, page.id), name).toBeNull();
    }
  });

  test('the embedding planner grants only what derivation spend left under the cap', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 1, calls);
      const stale = [{ chunk_index: 0, chunk_text: 'alpha '.repeat(200) }, { chunk_index: 1, chunk_text: 'beta '.repeat(200) }];
      const decision = await planPageEmbedding(engine, page, stale, { signature: 'openai:text-embedding-3-large:1536', approvedCapUsd: 0 });
      expect(decision.kind, name).toBe('grant');
      if (decision.kind !== 'grant') continue;
      expect({ granted: decision.grant.chunkIndexes.size, deferred: decision.grant.deferred }, name).toEqual({ granted: 0, deferred: 2 });
      await decision.grant.settle({ ok: true });
    }
  });
  test('a settle after its reservation was folded into spent as stale changes nothing; the newer reservation is untouched', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      // The ledger is aged by rewriting its times; the 2 ms let the clock (1 ms resolution on PGLite) pass A's reservation time as an hour would.
      const age = async () => { await new Promise(resolve => setTimeout(resolve, 2)); await engine.executeRaw("UPDATE page_embedding_budget SET reserved_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE page_id = $1", [page.id]); };
      const a = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.25);
      await age();
      const b = await reservePageSpend(engine, page, 'atoms:anthropic:claude-haiku-5-5', 0.125);
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.25, reserved: 0.125, signature: null });
      if (a.kind !== 'grant' || b.kind !== 'grant') throw new Error(name + ': expected two grants');
      await a.grant.settle({ ok: true });
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.25, reserved: 0.125, signature: null });
      await a.grant.settle({ ok: false });
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.25, reserved: 0.125, signature: null });
      await b.grant.settle({ ok: true });
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.375, reserved: 0, signature: null });
    }
  });

  test('an embedding grant folded by a later derivation reservation is not booked twice', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const stale = [{ chunk_index: 0, chunk_text: 'alpha '.repeat(2000) }];
      const a = await planPageEmbedding(engine, page, stale, { signature: 'openai:text-embedding-3-large:1536', approvedCapUsd: 1 });
      if (a.kind !== 'grant' || a.grant.reservedUsd <= 0) throw new Error(name + ': expected an embedding grant with a reservation');
      await new Promise(resolve => setTimeout(resolve, 2));
      await engine.executeRaw("UPDATE page_embedding_budget SET reserved_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE page_id = $1", [page.id]);
      const b = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.125);
      if (b.kind !== 'grant') throw new Error(name + ': expected a facts grant');
      const folded = await ledger(engine, page.id);
      await a.grant.settle({ ok: true });
      expect(await ledger(engine, page.id), name).toEqual(folded);
      expect(folded, name).toEqual({ spent: a.grant.reservedUsd, reserved: 0.125, signature: 'openai:text-embedding-3-large:1536' });
    }
  });
  test('a new embedding model replaces the ledger: the old model\'s open grant settles into nothing', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const a = await reservePageSpend(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.25);
      const b = await reservePageSpend(engine, page, 'embedding:voyage:voyage-4:1024', 0.125);
      if (a.kind !== 'grant' || b.kind !== 'grant') throw new Error(name + ': expected two grants');
      await a.grant.settle({ ok: true });
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0, reserved: 0.125, signature: 'voyage:voyage-4:1024' });
      await b.grant.settle({ ok: true });
      expect(await ledger(engine, page.id), name).toEqual({ spent: 0.125, reserved: 0, signature: 'voyage:voyage-4:1024' });
    }
  });
});
