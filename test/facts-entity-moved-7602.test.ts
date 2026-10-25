/**
 * #7602: two extractions from different source pages target the same entity page. One publishes first; the other's
 * entity request, admitted at the revision it read, is refused `revision_conflict` at preparation. The batch is keyed
 * by the page write it extracts from, so every facts-absorb retry replayed the same stored refusal until the job died
 * and the facts were dropped.
 *
 * 1. Protects: the refused request's retained facts are re-admitted at the entity's current revision and publish in the
 *    same run, with no second model call; a retry replays that outcome and admits nothing; the historical receipt is
 *    left as it was. A page that keeps moving is followed at most three times, a deleted entity page is not followed,
 *    and the refusal that stands is not retryable, so the job dead-letters on its first attempt instead of five.
 * 2. Fails when: the refusal replays (master before the fix), a follow-up re-runs the model, the cap is exceeded, a
 *    deleted page is re-targeted, or a standing refusal is retried.
 * 3. test/facts-absorb-stalled-receipt-7439.test.ts and test/managed-facts-withdrawal-recovery-6506.test.ts cover the
 *    file-check and withdrawal follow-ups this walk mirrors.
 * 4. Seams: the race is made deterministic by publishing the competing extraction while the losing one reads the
 *    entity page (the snapshot it then admits against is the one from before); gateway test transports.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import type { ManagedBrain } from './helpers/managed-brain.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const TARGET = 'people/alice-example';
const CLAIM_B = 'Alice-example owns the synthetic onboarding checklist.';
const BODY = 'Notes from a synthetic planning chat about the onboarding checklist and the launch date, kept for the regression.';

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

async function put(ctx: ManagedBrain['ctx'], slug: string, type: string) {
  const requestId = randomUUID();
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId,
    content: `---\ntype: ${type}\ntitle: Example\n---\n${BODY} (${slug})\n` } });
  const [write] = await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return write!.id;
}

const fact = (claim: string) => ({ fact: claim, kind: 'fact' as const, source: 'mcp:put_page', entity_slug: TARGET, confidence: 0.9, notability: 'high' as const, embedding: null });

/** A committed write of a source page and its extraction: the backstop context, the input and a fresh session per run. */
async function extraction({ engine, ctx }: ManagedBrain, slug: string) {
  const write = await put(ctx, slug, 'meeting');
  const backstop: FactsBackstopCtx = { engine, sourceId: 'default', source: 'mcp:put_page', sessionId: null, persistenceRequestId: write, operationContext: ctx };
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const input = { turnText: snapshot.page.compiled_truth, pageSlug: slug };
  return { slug, write, snapshot, backstop, input, session: async () => (await prepareManagedFactsSession(backstop, input))! };
}

/**
 * The race: while the losing extraction reads the entity page before admitting (and again before each follow-up),
 * `move` publishes a competing write of that page, and the read returns the snapshot from before it.
 */
function raceEntityReads(engine: ManagedBrain['engine'], times: number, move: (n: number) => Promise<void>) {
  const read = engine.readPageSnapshot;
  let moves = 0, moving = false;
  engine.readPageSnapshot = (async function (this: typeof engine, slug: string, opts?: Parameters<typeof read>[1]) {
    const reader = /publishManagedFacts|readmitMovedFacts/.test(new Error().stack ?? '');
    const before = await read.call(this, slug, opts);
    if (this !== engine || slug !== TARGET || !reader || moving || moves >= times) return before;
    moving = true;
    try { await move(moves++); } finally { moving = false; }
    return before;
  }) as typeof engine.readPageSnapshot;
  return { moves: () => moves, restore: () => { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; } };
}

/** Each move publishes another extraction's fact onto the entity page, as a concurrent facts-absorb job would. */
async function competitors(brain: ManagedBrain, count: number) {
  const list: Array<Awaited<ReturnType<typeof extraction>>> = [];
  for (let i = 0; i < count; i++) list.push(await extraction(brain, `chats/source-${String.fromCharCode(97 + i)}`));
  return async (n: number) => {
    const competitor = list[n]!;
    const published = await publishManagedFacts(brain.engine, await competitor.session(), competitor.backstop,
      [fact(`Alice-example confirmed synthetic item ${n + 1}.`)], 'private', competitor.slug);
    expect(published.inserted).toBe(1);
  };
}

const entityRequests = (engine: ManagedBrain['engine']) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null; error_message: string | null }>(
  "SELECT request_id, state, error_code, error_message FROM persistence_requests WHERE operation='extract_facts' AND slug=$1 AND intent->>'origin' LIKE '%chats/source-loser%' ORDER BY sequence", [TARGET]);
const claimB = (engine: ManagedBrain['engine']) => engine.executeRaw<{ fact: string; source_markdown_slug: string | null }>(
  'SELECT fact, source_markdown_slug FROM facts WHERE fact=$1', [CLAIM_B]);

/** The `gbrain repair failed-writes` preview rows for the losing extraction's entity requests. */
async function factsListing(engine: ManagedBrain['engine']) {
  const preview = await (await repairRunner(engine, { apply: false, logger: { info() {}, warn() {}, error() {} } }))
    .run('failed-writes', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default' });
  return (preview.listing ?? []).filter(entry => entry.item.includes(`${TARGET} extract_facts`));
}

function jobContext(loser: Awaited<ReturnType<typeof extraction>>, id: number): MinionJobContext {
  const signal = new AbortController().signal;
  return { id, name: 'facts-absorb', attempts_made: 0, signal, deadlineAtMs: null, shutdownSignal: signal,
    data: { slug: loser.slug, sourceId: 'default', source: 'mcp:put_page', sessionId: `put_page:${loser.slug}`, visibility: 'private',
      persistence_request_id: loser.write, page_id: loser.snapshot.page.id, revision: loser.snapshot.revision },
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
}

/** A keyed chat stub that extracts CLAIM_B about the entity; returns the call counter. */
async function stubExtraction(engine: ManagedBrain['engine']) {
  const calls = { n: 0 };
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls.n++;
    return { text: JSON.stringify({ facts: [{ fact: CLAIM_B, kind: 'fact', entity: TARGET, confidence: 0.9, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('embedding_disabled', 'true');
  return calls;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = async (brain: ManagedBrain, competing: number) => {
    await put(brain.ctx, TARGET, 'person');
    const move = await competitors(brain, competing);
    return { move, loser: await extraction(brain, 'chats/source-loser') };
  };

  test(`#7602 [${backend}]: an extraction that lost the race on its entity page publishes its retained facts in the same run`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const race = raceEntityReads(engine, 1, move);
    const first = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).finally(race.restore);
    expect(race.moves()).toBe(1);
    expect(first.inserted).toBe(1);
    expect(first.refused).toBeUndefined();
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect((await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!.page.compiled_truth).toContain(CLAIM_B);
    const requests = await entityRequests(engine);
    expect(requests.map(row => [row.state, row.error_code, row.error_message])).toEqual([
      ['conflict', 'revision_conflict', 'The fact entity changed after extraction admission.'], ['committed', null, null]]);
    for (let retry = 0; retry < 4; retry++) expect((await resumeManagedFacts(engine, await loser.session()))?.inserted).toBe(1);
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toHaveLength(1);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: a page that moves before every follow-up is followed three times, then the refusal stands and is not retryable`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 4);
    const race = raceEntityReads(engine, 4, move);
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(race.moves()).toBe(4);
    expect(refused.code).toBe('revision_conflict');
    expect(refused.retryable).toBe(false);
    const requests = await entityRequests(engine);
    expect(requests).toHaveLength(4);
    expect(requests.every(row => row.state === 'conflict' && row.error_code === 'revision_conflict')).toBe(true);
    const retry = await resumeManagedFacts(engine, await loser.session()).catch(error => error);
    expect([retry.code, retry.retryable]).toEqual(['revision_conflict', false]);
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toEqual([]);
    const listing = await factsListing(engine);
    expect(listing).toHaveLength(4);
    for (const entry of listing) {
      expect(entry.class).toBe('producer_owned');
      expect(entry.detail).toStartWith(`re-extract: gbrain call extract_facts again on the current text of ${loser.slug} with a new request_id`);
      expect(entry.detail).not.toContain('extract --stale');
    }
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: a refusal stored before the fix is listed with the job retry that recovers its facts, and the retry's replay publishes them`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const before = await loser.session();
    before.entityMoveRetry = false;
    const race = raceEntityReads(engine, 1, move);
    const refused = await publishManagedFacts(engine, before, loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect(refused.code).toBe('revision_conflict');
    const [entry, ...others] = await factsListing(engine);
    expect(others).toEqual([]);
    expect(entry!.class).toBe('producer_owned');
    expect(entry!.detail).toStartWith(`recover: gbrain facts retry-dead --reset 'facts-absorb:write:${loser.write}'`);
    const retried = await resumeManagedFacts(engine, await loser.session());
    expect(retried?.inserted).toBe(1);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
    expect(await factsListing(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: an entity page deleted after admission is not re-targeted; the refusal is not retryable`, () => managedBrain(async brain => {
    const { engine, ctx } = brain;
    const { loser } = await setup(brain, 0);
    const race = raceEntityReads(engine, 1, async () => {
      const snapshot = (await engine.readPageSnapshot(TARGET, { sourceId: 'default' }))!;
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: TARGET, expected_revision: snapshot.revision, request_id: randomUUID() } });
    });
    const refused = await publishManagedFacts(engine, await loser.session(), loser.backstop, [fact(CLAIM_B)], 'private', loser.slug).catch(error => error).finally(race.restore);
    expect([refused.code, refused.retryable]).toEqual(['revision_conflict', false]);
    expect((await entityRequests(engine)).map(row => row.state)).toEqual(['conflict']);
    expect(await claimB(engine)).toEqual([]);
    expect((await factsListing(engine)).map(entry => entry.detail)).toEqual([`not recoverable: entity page ${TARGET} was deleted after these facts were admitted`]);
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: the facts-absorb job that lost the race completes in one attempt with one model call`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 1);
    const calls = await stubExtraction(engine);
    const race = raceEntityReads(engine, 1, move);
    const result = await makeFactsAbsorbHandler(engine)(jobContext(loser, 1)).finally(race.restore) as { inserted: number };
    expect(race.moves()).toBe(1);
    expect(result.inserted).toBe(1);
    expect(calls.n).toBe(1);
    expect(await claimB(engine)).toEqual([{ fact: CLAIM_B, source_markdown_slug: TARGET }]);
  }, { databaseUrl }), 120_000);

  test(`#7602 [${backend}]: a standing refusal dead-letters the facts-absorb job on its first attempt; a retry calls no model`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { move, loser } = await setup(brain, 4);
    const calls = await stubExtraction(engine);
    const race = raceEntityReads(engine, 4, move);
    const handler = makeFactsAbsorbHandler(engine);
    const first: Error = await handler(jobContext(loser, 1)).then(() => new Error('the job completed')).catch(error => error).finally(race.restore);
    expect(first).toBeInstanceOf(UnrecoverableError);
    expect(first.message).toContain('facts_absorb_write_refused (revision_conflict)');
    expect(calls.n).toBe(1);
    const requests = await entityRequests(engine);
    expect(await handler(jobContext(loser, 1)).catch(error => error)).toBeInstanceOf(UnrecoverableError);
    expect(calls.n).toBe(1);
    expect(await entityRequests(engine)).toEqual(requests);
    expect(await claimB(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);
}
