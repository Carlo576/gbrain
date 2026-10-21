/**
 * Seeded property test of the conversation facts deletion invariant on a segmented page (wave-b spec 8.2; PR 4 lane 4b
 * round 5), shared by the PGLite arm (test/large-pages/conversation-facts-property.test.ts) and the Postgres arm
 * (test/e2e/conversation-facts-property-postgres.test.ts). A fake extractor yields one to three facts per window,
 * determined by the window's text; no model is called.
 *
 * Each of PROPERTY_SEEDS seeds runs PROPERTY_STEPS steps, each an optional change (an append on the last day or a new
 * day through the remote append_page, a mid-page edit, insert, delete or oversized turn, a title of another length, a
 * visibility, model or derivation-version change) followed by one run under an optional constraint (a provider-wide
 * failure, a window-specific failure, a cap, an abort, --since, --segment-limit, --force). After every step:
 *   (i)   a fact that disappeared had its exact window key extracted again (or a moved window's facts re-anchored onto
 *         it) in that step, or the step fully settled the page and its key is no current window's; a moved fact keeps
 *         its window text;
 *   (ii)  every window key holds exactly one batch: the fact count its text yields, no fact twice;
 *   (iii) every window a row claims holds exactly the facts the row says, and a settled page holds only current windows.
 * At the end a healthy unconstrained --force run leaves the same windows and facts as one extraction of the same page on
 * a fresh brain.
 *
 * 1. Protects: deletion only by exact-key replacement or settled collection, rows claiming exactly what exists.
 * 2. Fails when: any partial-run path deletes by coverage, keeps or stale bookkeeping, a move loses or duplicates a
 *    batch, a settling run leaves an old batch beside a new one, or incremental runs drift from a fresh extraction.
 */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_DERIVATION_VERSION } from '../../src/core/facts/conversation-incremental.ts';
import { parseSourceWindow, sourceWindowKey, type SourceWindow } from '../../src/core/page-body/derivations.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { __setChatTransportForTests, chat as gatewayChat } from '../../src/core/ai/gateway.ts';
import { chatDays, chatPage, derivations, PAID_MODEL, paidTransport, SOURCE, turns } from './conversation-facts-incremental-cases.ts';
import { claimMismatches } from './conversation-facts-invariant-cases.ts';

export const PROPERTY_SEEDS = 30;
export const PROPERTY_STEPS = 16;
const FIRST_DAY = 5000;
const DAYS = 100;
const WORDS = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency', 'onboarding', 'forecast', 'retention', 'deploy'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const dateOf = (day: number) => new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
/** Facts the fake extractor yields for a window, by its text. */
const yieldOf = (windowSha: string) => 1 + (parseInt(windowSha.slice(0, 2), 16) % 3);

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

interface Fact { id: number; key: string; fact: string }
async function factsOf(engine: BrainEngine, slug: string): Promise<Fact[]> {
  const rows = await engine.executeRaw<{ id: number; w: unknown; fact: string }>(
    `SELECT id, source_window AS w, fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source=$2 AND expired_at IS NULL ORDER BY id`, [slug, SOURCE]);
  return rows.map(row => { const w = parseSourceWindow(row.w) as SourceWindow | null; return { id: Number(row.id), key: w ? sourceWindowKey(w) : 'unanchored', fact: row.fact }; });
}
const shaOf = (key: string) => key.split(':')[2] ?? key;

interface RunOpts { force?: boolean; segmentLimit?: number; sinceIso?: string; abortAfter?: number; failAt?: number; doomed?: boolean; paid?: boolean }

/** One extraction run with the deterministic fake extractor; returns whether it threw and its counters. */
async function run(engine: BrainEngine, slug: string, o: RunOpts) {
  const controller = new AbortController();
  let calls = 0;
  try {
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, force: o.force, sinceIso: o.sinceIso, segmentLimit: o.segmentLimit,
      extractor: async input => {
        calls++;
        const windowSha = sha(input.turnText);
        if (o.paid) await gatewayChat({ model: PAID_MODEL, messages: [{ role: 'user', content: input.turnText }], maxTokens: 64 });
        if (calls === o.failAt) throw Object.assign(new Error('fake provider: upstream unavailable'), { status: 503 });
        if (o.doomed && /^[01]/.test(windowSha)) throw Object.assign(new Error('fake extractor: malformed output on this window'), { extractionReason: 'malformed_output' });
        if (calls === o.abortAfter) controller.abort();
        return Array.from({ length: yieldOf(windowSha) }, (_, j) => ({ fact: `Alice Example noted window ${windowSha.slice(0, 16)} item ${j}`, kind: 'fact', entity_slug: null, source: SOURCE }));
      } }, controller.signal);
    return { threw: false, failed: result.pages_failed };
  } catch {
    return { threw: true, failed: 1 };
  }
}

/** Every window key some row records, whether the page is fully settled, and the live occurrences' row windows. */
async function pageState(engine: BrainEngine, slug: string) {
  const d = await derivations(engine, slug);
  const liveRows = d.rows.filter(row => d.live.includes(row.occurrenceId));
  const windowsOf = (row: (typeof d.rows)[number]) => ((row.output as { windows?: Array<{ ordinal: number; sha: string; failed?: unknown }> })?.windows ?? []);
  const liveKeys = new Set(liveRows.flatMap(row => windowsOf(row).map(w => `${row.occurrenceId}:${w.ordinal}:${w.sha}`)));
  const settled = liveRows.length === d.live.length && liveRows.every(row => row.state === 'done' && row.version === CONVERSATION_FACTS_DERIVATION_VERSION)
    && d.rows.every(row => windowsOf(row).every(w => !w.failed));
  return { liveKeys, settled, windowShas: liveRows.flatMap(row => windowsOf(row).map(w => w.sha)).sort() };
}

/** Problems with one page's facts after a step (the module doc's (i)–(iii)). */
async function violations(engine: BrainEngine, slug: string, before: Fact[], o: RunOpts, outcome: { threw: boolean; failed: number }) {
  const after = await factsOf(engine, slug);
  const state = await pageState(engine, slug);
  const fullySettled = !outcome.threw && outcome.failed === 0 && !o.sinceIso && state.settled;
  const beforeById = new Map(before.map(f => [f.id, f]));
  const afterById = new Map(after.map(f => [f.id, f]));
  const replaced = new Set([...after.filter(f => !beforeById.has(f.id)).map(f => f.key),
    ...after.filter(f => beforeById.has(f.id) && beforeById.get(f.id)!.key !== f.key).map(f => f.key)]);
  const problems: string[] = [];
  for (const f of before) {
    if (afterById.has(f.id)) continue;
    if (replaced.has(f.key) || (fullySettled && !state.liveKeys.has(f.key))) continue;
    problems.push(`(i) fact ${f.id} of window ${f.key} disappeared without its window being extracted again or a settled collection`);
  }
  for (const f of after) {
    const was = beforeById.get(f.id);
    if (was && shaOf(was.key) !== shaOf(f.key)) problems.push(`(i) fact ${f.id} moved from ${was.key} to a window of other text ${f.key}`);
  }
  const perKey = new Map<string, Fact[]>();
  for (const f of after) perKey.set(f.key, [...(perKey.get(f.key) ?? []), f]);
  for (const [key, facts] of perKey) {
    if (key === 'unanchored') continue;
    if (facts.length !== yieldOf(shaOf(key)) || new Set(facts.map(f => f.fact)).size !== facts.length) problems.push(`(ii) window ${key} holds ${facts.length} facts, ${new Set(facts.map(f => f.fact)).size} distinct; its text yields ${yieldOf(shaOf(key))}`);
  }
  for (const m of await claimMismatches(engine, slug)) problems.push(`(iii) a row claims ${m.claimed} facts of ${m.key}; it holds ${m.held}`);
  if (fullySettled) for (const key of perKey.keys()) if (!state.liveKeys.has(key)) problems.push(`(iii) the settled page still holds facts of ${key}, no current window`);
  return { problems, after };
}

export function defineConversationFactsPropertyCases(opts: { getBrain: () => AppendBrain; getFresh: () => AppendBrain }): void {
  for (let seed = 1; seed <= PROPERTY_SEEDS; seed++) {
    test(`seed ${seed}: ${PROPERTY_STEPS} seeded changes and constrained runs keep the deletion invariant, and the page converges to a fresh extraction`, async () => {
      const brain = opts.getBrain();
      const engine = brain.engine;
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
      const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
      const slug = `notes/property-${seed}-${randomUUID().slice(0, 8)}`;
      for (const key of [PAGE_DERIVATION_CAP_KEY, PAGE_EMBED_CAP_KEY]) await engine.setConfig(key, 'off');
      await engine.setConfig('facts.extraction_model', '');
      await engine.setConfig('facts.default_visibility', 'private');
      let title = 'Property chat';
      let lastDay = FIRST_DAY + DAYS - 1;
      let nextTurn = 50;
      await brain.seed(slug, chatPage(title, chatDays(FIRST_DAY, DAYS, seed)));
      const log: string[] = [];
      let facts = await factsOf(engine, slug);
      const reseed = async (edit: (lines: string[], turnsAt: number[]) => void) => {
        const lines = (await brain.body(slug)).truth.split('\n');
        const turnsAt = lines.flatMap((line, i) => (line.startsWith('**') ? [i] : []));
        edit(lines, turnsAt.slice(Math.floor(turnsAt.length / 3), Math.floor((2 * turnsAt.length) / 3)));
        await brain.seed(slug, chatPage(title, lines.join('\n')));
      };
      try {
        for (let step = 1; step <= PROPERTY_STEPS + 1; step++) {
          const final = step > PROPERTY_STEPS;
          const change = final ? 'none' : pick(['none', 'none', 'append', 'append', 'append', 'new-day', 'edit', 'edit', 'insert', 'insert', 'delete', 'oversized',
            'title', 'title', 'visibility', 'model', 'version'] as const);
          if (change === 'append') {
            const count = 1 + Math.floor(next() * 20);
            expect(await brain.call('append_page', { slug, text: turns(lastDay, nextTurn, count, seed * 100 + step), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
            nextTurn += count;
          } else if (change === 'new-day') {
            lastDay++;
            nextTurn = 1 + Math.floor(next() * 30);
            expect(await brain.call('append_page', { slug, text: `## ${dateOf(lastDay)}\n\n${turns(lastDay, 0, nextTurn, seed * 100 + step)}`, request_id: randomUUID() }, { remote: true }))
              .toMatchObject({ isError: false });
          } else if (change === 'edit' || change === 'oversized') {
            await reseed((lines, mid) => { const i = pick(mid); lines[i] = lines[i]!.replace(/\): .*$/, `): ${words(change === 'oversized' ? 1800 : 5 + Math.floor(next() * 40))} (step ${step}).`); });
          } else if (change === 'insert') {
            await reseed((lines, mid) => { const i = pick(mid); lines.splice(i + 1, 0, '', lines[i]!.replace(/\): .*$/, `): ${words(10 + Math.floor(next() * 30))} (inserted ${step}).`)); });
          } else if (change === 'delete') {
            await reseed((lines, mid) => { lines.splice(pick(mid), 1); });
          } else if (change === 'title') {
            title = `Property ${words(1 + Math.floor(next() * 12))}`;
            await reseed(() => {});
          } else if (change === 'visibility') {
            await engine.setConfig('facts.default_visibility', (await engine.getConfig('facts.default_visibility')) === 'world' ? 'private' : 'world');
          } else if (change === 'model') {
            await engine.setConfig('facts.extraction_model', (await engine.getConfig('facts.extraction_model')) === PAID_MODEL ? '' : PAID_MODEL);
          } else if (change === 'version') {
            const { pageId, rows } = await derivations(engine, slug);
            for (const row of rows) {
              const output = row.output as { windows?: Array<Record<string, unknown>> };
              const windows = (output.windows ?? []).map(w => ({ ...w, span: [row.occurrenceId, Number(w.ordinal), row.occurrenceId, Number(w.ordinal) + 3] }));
              await engine.executeRaw(`UPDATE page_segment_derivations SET pipeline_version = $1, output = $2::jsonb WHERE page_id = $3 AND pipeline = 'conversation_facts' AND occurrence_id = $4`,
                [1 + Math.floor(next() * (CONVERSATION_FACTS_DERIVATION_VERSION - 1)), JSON.stringify({ ...output, windows }), pageId, row.occurrenceId]);
            }
          }
          const constraint = final ? 'force' : pick(['none', 'none', 'none', 'limit', 'limit', 'abort', 'abort', 'provider', 'provider', 'doomed', 'doomed', 'since', 'cap', 'force'] as const);
          const o: RunOpts = {};
          if (constraint === 'force' || (['visibility', 'model', 'version'].includes(change) && next() < 0.7)) o.force = true;
          if (constraint === 'limit') o.segmentLimit = 1 + Math.floor(next() * 20);
          if (constraint === 'abort') o.abortAfter = 1 + Math.floor(next() * 30);
          if (constraint === 'provider') o.failAt = 1 + Math.floor(next() * 30);
          if (constraint === 'doomed') o.doomed = true;
          if (constraint === 'since') o.sinceIso = `${dateOf(FIRST_DAY + Math.floor(next() * (lastDay - FIRST_DAY)))}T12:00:00Z`;
          if (constraint === 'cap') {
            const { pageId } = await derivations(engine, slug);
            const [ledger] = await engine.executeRaw<{ spent: number }>("SELECT spent_usd AS spent FROM page_derivation_spend WHERE page_id=$1 AND family='facts'", [pageId]);
            await engine.setConfig(PAGE_DERIVATION_CAP_KEY, (Number(ledger?.spent ?? 0) + 0.02 + next() * 0.3).toFixed(4));
            __setChatTransportForTests(paidTransport);
            o.paid = true;
          }
          const outcome = await run(engine, slug, o).finally(async () => {
            __setChatTransportForTests(null);
            await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
          });
          const checked = await violations(engine, slug, facts, o, outcome);
          log.push(`step ${step}: ${change} + ${constraint} ${JSON.stringify(o)} -> ${JSON.stringify(outcome)}, ${checked.after.length} facts`);
          expect({ step, log: log.at(-1), problems: checked.problems.slice(0, 5) }).toEqual({ step, log: log.at(-1), problems: [] });
          facts = checked.after;
        }
        const state = await pageState(engine, slug);
        expect({ settled: state.settled, log: log.at(-1) }).toEqual({ settled: true, log: log.at(-1) });
        // The same page, extracted once on a fresh brain under the same configuration.
        const fresh = opts.getFresh();
        const freshSlug = `notes/property-fresh-${seed}-${randomUUID().slice(0, 8)}`;
        for (const key of ['facts.extraction_model', 'facts.default_visibility']) await fresh.engine.setConfig(key, (await engine.getConfig(key)) ?? '');
        for (const key of [PAGE_DERIVATION_CAP_KEY, PAGE_EMBED_CAP_KEY]) await fresh.engine.setConfig(key, 'off');
        await fresh.seed(freshSlug, chatPage(title, (await brain.body(slug)).truth));
        expect(await run(fresh.engine, freshSlug, {})).toEqual({ threw: false, failed: 0 });
        const freshState = await pageState(fresh.engine, freshSlug);
        const byWindow = (list: Fact[]) => list.map(f => `${shaOf(f.key)} ${f.fact}`).sort();
        expect({ windows: state.windowShas.length, sameWindows: state.windowShas.join() === freshState.windowShas.join(), facts: facts.length,
          sameFacts: byWindow(facts).join('\n') === byWindow(await factsOf(fresh.engine, freshSlug)).join('\n') })
          .toEqual({ windows: freshState.windowShas.length, sameWindows: true, facts: (await factsOf(fresh.engine, freshSlug)).length, sameFacts: true });
      } finally {
        await engine.setConfig('facts.extraction_model', '');
        await engine.setConfig('facts.default_visibility', 'private');
      }
    }, 900_000);
  }
}
