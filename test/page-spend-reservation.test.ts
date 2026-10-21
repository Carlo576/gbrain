/**
 * Per-page spend ledgers (wave-b spec 8.3, PR 4 lane 4b): embeddings reserve on page_embedding_budget under
 * `embed.max_usd_per_page`; each paid derivation family (facts, atoms, synopsis) reserves on its own page_derivation_spend
 * row under `derive.max_usd_per_page`; meterPaidCall books what the provider reported.
 *
 * 1. Protects: each family has its own cap and the embedding cap counts embeddings only; a reservation over what a cap
 *    leaves refuses before the (fake) provider call and reserves nothing; a failed call releases its reservation; a new
 *    embedding model resets the embedding ledger only, never derivation spend or an in-flight derivation reservation;
 *    concurrent reservations never overspend a cap; a settle after its reservation was folded as stale books nothing;
 *    a metered call books the provider-reported cost of every attempt (a throw after the answer included), the
 *    reservation for an unpriced model and nothing when the provider was never called or rejected the attempt unanswered; the estimate honors
 *    pricing.overrides and covers every attempt of a facts extraction.
 * 2. Fails when: derivation spend starves embeddings, an embedding switch forgives or drops derivation spend, a refusal
 *    runs the call, a race overspends, a folded grant is booked twice, or booking ignores what the provider reported.
 * PGLite always; Postgres too when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_EMBED_CAP_KEY, estimateChatCallUsd, estimateFactsExtractionUsd, meterPaidCall, planPageEmbedding, reservePageSpend, spendGrant,
  type PageSpendSignature } from '../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../src/core/page-spend.ts';
import { __setChatTransportForTests, chat, type ChatResult } from '../src/core/ai/gateway.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';
import { parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';
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
  for (const { engine } of engines) { await engine.setConfig(PAGE_EMBED_CAP_KEY, '1'); await engine.setConfig(PAGE_DERIVATION_CAP_KEY, '1'); }
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  for (const { name, engine } of engines) if (name === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

/** A stored page row standing in for a segmented page of `bytes` (the ledgers read only its id and shape). */
async function segmentedPage(engine: BrainEngine, bytes = 40 * 1024 * 1024) {
  const slug = `conversations/spend-${randomUUID().slice(0, 8)}`;
  await engine.putPage(slug, { type: 'conversation', title: 'Spend probe', compiled_truth: 'body' });
  const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'", [slug]);
  return { id: Number(row!.id), body_storage: 'segmented' as const, body_bytes: bytes };
}

async function embedLedger(engine: BrainEngine, pageId: number) {
  const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number; embedding_signature: string | null }>(
    'SELECT spent_usd, reserved_usd, embedding_signature FROM page_embedding_budget WHERE page_id = $1', [pageId]);
  return row ? { spent: Number(row.spent_usd), reserved: Number(row.reserved_usd), signature: row.embedding_signature } : null;
}

async function familyLedger(engine: BrainEngine, pageId: number, family: string) {
  const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number }>(
    'SELECT spent_usd, reserved_usd FROM page_derivation_spend WHERE page_id = $1 AND family = $2', [pageId, family]);
  return row ? { spent: Number(row.spent_usd), reserved: Number(row.reserved_usd) } : null;
}

/** One fake paid call under a reservation: the call runs only on a grant, and books its reservation. */
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

const HAIKU = 'anthropic:claude-haiku-4-5';
const answer = (input: number, output: number): ChatResult => ({ text: 'ok', blocks: [], stopReason: 'end', model: HAIKU, providerId: 'anthropic',
  usage: { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_creation_tokens: 0 } });

describe('per-page spend ledgers', () => {
  test('each derivation family has its own cap and the embedding cap counts embeddings only; a refusal books nothing', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      expect((await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.6, calls)).kind, name).toBe('grant');
      expect((await paidStep(engine, page, 'atoms:anthropic:claude-haiku-5-5', 0.5, calls)).kind, name).toBe('grant');
      const refused = await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.5, calls);
      expect(refused, name).toEqual({ kind: 'refused', reason: 'cap_reached', capUsd: 1, spentUsd: 0.6, reservedUsd: 0, estimateUsd: 0.5 });
      expect(calls.n, name).toBe(2);
      expect((await paidStep(engine, page, 'embedding:openai:text-embedding-3-large:1536', 1, calls)).kind, name).toBe('grant');
      expect((await paidStep(engine, page, 'synopsis:anthropic:claude-haiku-5-5', 0.9, calls)).kind, name).toBe('grant');
      expect(calls.n, name).toBe(4);
      expect({ facts: await familyLedger(engine, page.id, 'facts'), atoms: await familyLedger(engine, page.id, 'atoms'),
        synopsis: await familyLedger(engine, page.id, 'synopsis'), embedding: await embedLedger(engine, page.id) }, name).toEqual({
        facts: { spent: 0.6, reserved: 0 }, atoms: { spent: 0.5, reserved: 0 }, synopsis: { spent: 0.9, reserved: 0 },
        embedding: { spent: 1, reserved: 0, signature: 'openai:text-embedding-3-large:1536' } });
    }
  });

  test('an open reservation counts against its family cap until it settles; a failed call releases it', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const first = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.7);
      expect(first.kind, name).toBe('grant');
      expect((await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.4)).kind, name).toBe('refused');
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0.7 });
      if (first.kind === 'grant') await first.grant.settle({ ok: false });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0 });
      const calls = { n: 0 };
      expect((await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.4, calls, true)).kind, name).toBe('grant');
      expect(calls.n, name).toBe(1);
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0 });
    }
  });

  test('a new embedding model resets the embedding ledger only; derivation spend and an open derivation reservation stay', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      await paidStep(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.5, calls);
      await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.5, calls);
      const open = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.25);
      expect((await paidStep(engine, page, 'embedding:voyage:voyage-4:1024', 0.3, calls)).kind, name).toBe('grant');
      expect({ embedding: await embedLedger(engine, page.id), facts: await familyLedger(engine, page.id, 'facts') }, name)
        .toEqual({ embedding: { spent: 0.3, reserved: 0, signature: 'voyage:voyage-4:1024' }, facts: { spent: 0.5, reserved: 0.25 } });
      // A facts model change keeps the family's spend: 0.5 spent + 0.25 open + 0.3 is over the cap.
      expect((await paidStep(engine, page, 'facts:openai:gpt-6-luna', 0.3, calls)).kind, name).toBe('refused');
      if (open.kind === 'grant') await open.grant.settle({ ok: true });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.75, reserved: 0 });
      expect(calls.n, name).toBe(3);
    }
  });

  test('a small inline page is unmetered and leaves no ledger row', async () => {
    for (const { name, engine } of engines) {
      const page = { id: (await segmentedPage(engine)).id, body_storage: 'inline' as const, compiled_truth: 'short', timeline: '' };
      expect(await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 50), name).toEqual({ kind: 'unmetered' });
      expect({ embedding: await embedLedger(engine, page.id), facts: await familyLedger(engine, page.id, 'facts') }, name).toEqual({ embedding: null, facts: null });
    }
  });

  test('the embedding planner is not limited by derivation spend', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 1, calls);
      const stale = [{ chunk_index: 0, chunk_text: 'alpha '.repeat(200) }, { chunk_index: 1, chunk_text: 'beta '.repeat(200) }];
      const decision = await planPageEmbedding(engine, page, stale, { signature: 'openai:text-embedding-3-large:1536', approvedCapUsd: 0 });
      expect(decision.kind, name).toBe('grant');
      if (decision.kind !== 'grant') continue;
      expect({ granted: decision.grant.chunkIndexes.size, deferred: decision.grant.deferred }, name).toEqual({ granted: 2, deferred: 0 });
      await decision.grant.settle({ ok: true });
    }
  });

  test('concurrent reservations on one family never overspend its cap', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const decisions = await Promise.all(Array.from({ length: 10 }, () => reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.3)));
      const grants = decisions.filter(d => d.kind === 'grant');
      expect({ grants: grants.length, refused: decisions.filter(d => d.kind === 'refused').length }, name).toEqual({ grants: 3, refused: 7 });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: expect.closeTo(0.9, 9) });
      await Promise.all(grants.map(d => d.kind === 'grant' ? d.grant.settle({ ok: true }) : null));
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: expect.closeTo(0.9, 9), reserved: 0 });
    }
  });

  test('a settle after its reservation was folded into spent as stale changes nothing; the newer reservation is untouched', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      // The ledger is aged by rewriting its times; the 2 ms let the clock (1 ms resolution on PGLite) pass A's reservation time as an hour would.
      const age = async () => { await new Promise(resolve => setTimeout(resolve, 2)); await engine.executeRaw("UPDATE page_derivation_spend SET reserved_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE page_id = $1", [page.id]); };
      const a = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.25);
      await age();
      const b = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.125);
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.25, reserved: 0.125 });
      if (a.kind !== 'grant' || b.kind !== 'grant') throw new Error(name + ': expected two grants');
      await a.grant.settle({ ok: true });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.25, reserved: 0.125 });
      await a.grant.settle({ ok: false });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.25, reserved: 0.125 });
      await b.grant.settle({ ok: true });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.375, reserved: 0 });
    }
  });

  test('an embedding grant folded by a later embedding reservation is not booked twice', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const stale = [{ chunk_index: 0, chunk_text: 'alpha '.repeat(2000) }];
      const a = await planPageEmbedding(engine, page, stale, { signature: 'openai:text-embedding-3-large:1536', approvedCapUsd: 1 });
      if (a.kind !== 'grant' || a.grant.reservedUsd <= 0) throw new Error(name + ': expected an embedding grant with a reservation');
      await new Promise(resolve => setTimeout(resolve, 2));
      await engine.executeRaw("UPDATE page_embedding_budget SET reserved_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE page_id = $1", [page.id]);
      const b = await reservePageSpend(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.125);
      if (b.kind !== 'grant') throw new Error(name + ': expected an embedding grant');
      const folded = await embedLedger(engine, page.id);
      await a.grant.settle({ ok: true });
      expect(await embedLedger(engine, page.id), name).toEqual(folded);
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
      expect(await embedLedger(engine, page.id), name).toEqual({ spent: 0, reserved: 0.125, signature: 'voyage:voyage-4:1024' });
      await b.grant.settle({ ok: true });
      expect(await embedLedger(engine, page.id), name).toEqual({ spent: 0.125, reserved: 0, signature: 'voyage:voyage-4:1024' });
    }
  });

  test('meterPaidCall books what the provider reported for every attempt, a throw after the answer included', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const answers = [answer(1000, 200), answer(3000, 400)];
      __setChatTransportForTests(async () => answers.shift()!);
      const ask = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 500 });
      const out = await meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, async () => { await ask(); await ask(); return 'done'; });
      const cost = reservationCostUsd(HAIKU, 'chat', 1000, 200)! + reservationCostUsd(HAIKU, 'chat', 3000, 400)!;
      expect({ out, ledger: await familyLedger(engine, page.id, 'facts') }, name).toEqual({ out: { value: 'done' }, ledger: { spent: expect.closeTo(cost, 12), reserved: 0 } });
      __setChatTransportForTests(async () => answer(2000, 100));
      await expect(meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, async () => { await ask(); throw new Error('parse failed after the answer'); }), name).rejects.toThrow('parse failed');
      const after = cost + reservationCostUsd(HAIKU, 'chat', 2000, 100)!;
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: expect.closeTo(after, 12), reserved: 0 });
      await expect(meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, async () => { throw new Error('failed before any call'); }), name).rejects.toThrow('before any call');
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: expect.closeTo(after, 12), reserved: 0 });
      __setChatTransportForTests(async () => ({ ...answer(10, 10), model: 'test:unpriced-model' }));
      await meterPaidCall(engine, page, 'atoms:test:unpriced-model', 0.05, () => chat({ model: 'test:unpriced-model', messages: [{ role: 'user', content: 'w' }], maxTokens: 50 }));
      expect(await familyLedger(engine, page.id, 'atoms'), name).toEqual({ spent: 0.05, reserved: 0 });
      __setChatTransportForTests(null);
    }
  });

  test('meterPaidCall books nothing for an attempt the provider rejected before answering (a rate limit), and the answered attempts beside it', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const ask = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 500 });
      let rejected = 0;
      __setChatTransportForTests(async () => {
        if (rejected++ === 0) throw Object.assign(new Error('fixture rate limit'), { status: 429 });
        return answer(1000, 200);
      });
      const out = await meterPaidCall(engine, page, `synopsis:${HAIKU}`, 0.2, async () => { await ask().catch(() => null); await ask(); return 'done'; });
      expect({ out, ledger: await familyLedger(engine, page.id, 'synopsis') }, name)
        .toEqual({ out: { value: 'done' }, ledger: { spent: expect.closeTo(reservationCostUsd(HAIKU, 'chat', 1000, 200)!, 12), reserved: 0 } });
      __setChatTransportForTests(async () => { throw Object.assign(new Error('fixture rate limit'), { status: 429 }); });
      await meterPaidCall(engine, page, `atoms:${HAIKU}`, 0.2, () => ask().catch(() => null));
      expect(await familyLedger(engine, page.id, 'atoms'), name).toEqual({ spent: 0, reserved: 0 });
      __setChatTransportForTests(null);
    }
  });

  test('the estimate honors pricing.overrides and a facts extraction reserves its call and both retries', () => {
    const base = estimateChatCallUsd(HAIKU, 4000, 1000);
    const overrides = parsePricingOverrides(JSON.stringify({ [HAIKU]: { input: 10, output: 100 } }));
    expect(estimateChatCallUsd(HAIKU, 4000, 1000, overrides)).toBeCloseTo(((4000 / 4 + 1500) * 10 + 1000 * 100) / 1_000_000, 12);
    expect(estimateChatCallUsd(HAIKU, 4000, 1000, overrides)).toBeGreaterThan(base);
    expect(estimateFactsExtractionUsd(HAIKU, 4000, 1000)).toBeCloseTo(base + 2 * estimateChatCallUsd(HAIKU, 4000, 2000), 12);
  });
});
