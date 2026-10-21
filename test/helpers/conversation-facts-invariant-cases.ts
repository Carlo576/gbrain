/**
 * Conversation facts deletion invariant on a segmented page (wave-b spec 8.2; PR 4 lane 4b round 5), shared by the PGLite
 * arm (test/large-pages/conversation-facts-incremental.test.ts) and the Postgres arm
 * (test/e2e/conversation-facts-incremental-postgres.test.ts). Fake extractors only; appends go through the remote
 * append_page operation (remote=true).
 *
 * 1. Protects: a partial run only adds and replaces facts per window key, and a row claims exactly the facts it holds:
 *    two interrupted runs after an append lose no fact a row claims (F1); a window marked failed right after an append
 *    leaves the facts of the window the append retired standing (F2); a run that re-extracts every window under an
 *    unchanged key (a model change) leaves one batch per key (F6); rows from an older derivation version are never
 *    read as window positions (F9); the grammar is detected over the whole page, not its head (F3), and that read is
 *    counted; a page that reads as a transcript yet parses no message changes nothing and leaves a no_messages receipt;
 *    a transcript whose format the whole page no longer shows yet still parses changes nothing and leaves a
 *    grammar_lost receipt (N1); an append that commits after the old version check and before the publication locks
 *    the page leaves the run unsettled (N2).
 * 2. Fails when: anything but an exact-key replacement or a fully settled collection deletes a fact, a moved window's
 *    old row keeps claiming it, a settling run keeps the old batch beside the new one, the head of a page picks its
 *    grammar, a lost grammar collects a transcript's facts, or a run settles a page version it did not read.
 */
import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import * as parser from '../../src/core/conversation-parser/parse.ts';
import { renderSegmentForExtraction, splitIntoSegments } from '../../src/core/facts/conversation-windows.ts';
import { WINDOW_FAILURE_LIMIT } from '../../src/core/facts/conversation-incremental.ts';
import { conversationDetectionWork } from '../../src/core/page-body/segment-conversation.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { chatDays, chatPage, derivations, extract, factsOf, turns } from './conversation-facts-incremental-cases.ts';

const caps = async (engine: BrainEngine, usd: string) => { await engine.setConfig(PAGE_DERIVATION_CAP_KEY, usd); await engine.setConfig(PAGE_EMBED_CAP_KEY, usd); };

/** Window records some row claims whose facts in the table are not exactly what the record says. */
export async function claimMismatches(engine: BrainEngine, slug: string) {
  const rows = await derivations(engine, slug);
  const facts = await factsOf(engine, slug);
  const count = new Map<string, number>();
  for (const f of facts) count.set(f.key, (count.get(f.key) ?? 0) + 1);
  return rows.rows.flatMap(row => ((row.output as { windows?: Array<{ ordinal: number; sha: string; facts: number }> })?.windows ?? [])
    .map(w => ({ key: `${row.occurrenceId}:${w.ordinal}:${w.sha}`, claimed: w.facts }))
    .filter(w => (count.get(w.key) ?? 0) !== w.claimed).map(w => ({ ...w, held: count.get(w.key) ?? 0 })));
}

/** A meeting-notes transcript (`**Name:** text`, no times) whose turns carry `notes` continuation lines each: sparse enough
 *  that text added around it can tip the whole-page density test. */
const sparseTranscript = (count: number, notes: number) => Array.from({ length: count }, (_, t) => [`**${['Alice Example', 'Bob Example', 'Carol Example'][t % 3]}:** turn ${t} opens the item`,
  ...Array.from({ length: notes }, (_, j) => `note ${j} of item ${t} on the roadmap review`)].join('\n')).join('\n\n');
const references = (count: number) => Array.from({ length: count }, (_, i) => `Reference ${i}: the roadmap review moved to next quarter and the budget stays flat.`).join('\n\n');

export function defineConversationFactsInvariantCases(opts: { getBrain: () => AppendBrain }): void {
  test('F1: two interrupted runs after an append lose no fact and leave every row claiming exactly the facts it holds', async () => {
    const brain = opts.getBrain();
    const slug = `notes/interrupted-moves-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Interrupted moves', chatDays(3800, 100, 31)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    // Three hundred more turns on the last day: its windows move to the occurrences the append makes.
    expect(await brain.call('append_page', { slug, text: turns(3899, 50, 300, 31), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const outcomes: unknown[] = [];
    for (const abortAfter of [2, 3]) {
      await extract(brain.engine, slug, { abortAfter }).catch(() => undefined);
      const now = await factsOf(brain.engine, slug);
      outcomes.push({ lost: before.filter(f => !now.some(n => n.id === f.id)).length, mismatches: (await claimMismatches(brain.engine, slug)).slice(0, 3) });
    }
    expect(outcomes).toEqual([{ lost: 0, mismatches: [] }, { lost: 0, mismatches: [] }]);
    await extract(brain.engine, slug);
    const after = await factsOf(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ mismatches: await claimMismatches(brain.engine, slug), facts: after.length, anchored: after.every(f => rows.keys.includes(f.key)), states: [...new Set(rows.states)] })
      .toEqual({ mismatches: [], facts: rows.keys.length, anchored: true, states: ['done'] });
  }, 600_000);

  test('F2: a window marked failed right after an append leaves the facts of the window the append retired standing', async () => {
    const brain = opts.getBrain();
    const slug = `notes/failed-after-append-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Failed after append', chatDays(3900, 100, 32)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    // Two more turns on the last day: its last window grows, and the window it was is retired.
    expect(await brain.call('append_page', { slug, text: turns(3999, 50, 2, 32), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    let grown = null as string | null;
    const failOn = (text: string) => { grown ??= text; return text === grown; };
    for (let run = 1; run <= WINDOW_FAILURE_LIMIT; run++) await extract(brain.engine, slug, { failOn });
    const after = await factsOf(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ lost: before.filter(f => !after.some(a => a.id === f.id)).length, failed: rows.receipts.filter(r => (r as { kind?: string } | null)?.kind === 'failed_windows').length,
      mismatches: await claimMismatches(brain.engine, slug) }).toEqual({ lost: 0, failed: 1, mismatches: [] });
  }, 600_000);

  test('F6: a model change re-extracts every window under its unchanged key and leaves one batch per key', async () => {
    const brain = opts.getBrain();
    const slug = `notes/model-change-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Model change', chatDays(4000, 100, 33)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    await brain.engine.setConfig('facts.extraction_model', 'anthropic:claude-haiku-4-5');
    try {
      const { calls, result } = await extract(brain.engine, slug, { force: true });
      const after = await factsOf(brain.engine, slug);
      const rows = await derivations(brain.engine, slug);
      const perKey = new Map<string, number>();
      for (const f of after) perKey.set(f.key, (perKey.get(f.key) ?? 0) + 1);
      expect({ calls: calls.length, facts: after.length, keys: new Set(rows.keys).size, sameKeys: [...perKey.keys()].sort().join() === before.map(f => f.key).sort().join(),
        doubled: [...perKey.values()].filter(n => n > 1).length, survivors: before.filter(f => after.some(a => a.id === f.id)).length, cleaned: result.orphan_facts_cleaned })
        .toEqual({ calls: before.length, facts: before.length, keys: before.length, sameKeys: true, doubled: 0, survivors: 0, cleaned: before.length + 1 });
    } finally {
      await brain.engine.setConfig('facts.extraction_model', '');
    }
  }, 600_000);

  test('F9: rows from an older derivation version (round-3 spans) are never read as positions: a one-window run after an append deletes nothing', async () => {
    const brain = opts.getBrain();
    const slug = `notes/old-rows-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Old rows', chatDays(4100, 100, 34)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    const { pageId, rows } = await derivations(brain.engine, slug);
    // Version 1 rows: spans were [occurrence, ordinal, occurrence, ordinal].
    for (const row of rows) {
      const output = row.output as { windows: Array<Record<string, unknown>> };
      const windows = output.windows.map(w => ({ ...w, span: [row.occurrenceId, 0, row.occurrenceId, 40] }));
      await brain.engine.executeRaw(`UPDATE page_segment_derivations SET pipeline_version = 1, output = $1::jsonb WHERE page_id = $2 AND pipeline = 'conversation_facts' AND occurrence_id = $3`,
        [JSON.stringify({ ...output, windows }), pageId, row.occurrenceId]);
    }
    expect(await brain.call('append_page', { slug, text: turns(4199, 50, 2, 34), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const limited = await extract(brain.engine, slug, { segmentLimit: 1 });
    const after = await factsOf(brain.engine, slug);
    expect({ calls: limited.calls.length, facts: after.length, lost: before.filter(f => !after.some(a => a.id === f.id)).length, cleaned: limited.result.orphan_facts_cleaned })
      .toEqual({ calls: 1, facts: before.length + 1, lost: 0, cleaned: 0 });
  }, 600_000);

  test('F3: the grammar is the whole page\'s, not its head\'s; the detection read is counted once, and a run on a pinned grammar reads none', async () => {
    const brain = opts.getBrain();
    const slug = `notes/preamble-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const preamble = Array.from({ length: 4000 }, (_, i) => (i % 4 === 3 ? 'User: a line of the preamble' : `Notes line ${i} about the roadmap review.`)).join('\n');
    await brain.seed(slug, chatPage('Preamble', `${preamble}\n\n${chatDays(4200, 100, 35)}`));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    const truth = (await brain.body(slug)).truth;
    expect(parser.parseConversation(truth.slice(0, 64 * 1024), { page }).matched_pattern_id).toBe('plain-role-no-time');
    expect(parser.parseConversation(truth, { page }).matched_pattern_id).toBe('bold-paren-time-12h');
    const expected = splitIntoSegments(parser.parseConversation(truth, { page }).messages, { pageTitle: 'Preamble' }).map(seg => renderSegmentForExtraction('Preamble', seg));
    const detected = conversationDetectionWork.bytes;
    const { calls } = await extract(brain.engine, slug, { segmentLimit: 5 });
    const read = conversationDetectionWork.bytes - detected;
    const rest = await extract(brain.engine, slug);
    const all = [...calls, ...rest.calls];
    expect({ read, again: conversationDetectionWork.bytes - detected - read, same: [...all].sort().join('\n') === [...expected].sort().join('\n') })
      .toEqual({ read: Buffer.byteLength(truth), again: 0, same: true });
  }, 600_000);

  test('a page that reads as a transcript yet parses no message changes nothing and leaves a no_messages receipt doctor lists', async () => {
    const brain = opts.getBrain();
    const slug = `notes/parser-fault-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Parser fault', chatDays(4300, 100, 36)));
    await extract(brain.engine, slug);
    const before = (await factsOf(brain.engine, slug)).map(f => f.id);
    await brain.seed(slug, chatPage('Parser fault', Array.from({ length: 8000 }, (_, i) => `Paragraph ${i} of the notes: the roadmap review moved to next quarter and the budget stays flat.`).join('\n\n')));
    // A detector fault: it reports a transcript format the page's text does not hold.
    const spy = spyOn(parser, 'createPatternDetector').mockImplementation(() => ({ push() {}, finish: () => 'bold-paren-time-12h' }));
    try {
      const { calls, result } = await extract(brain.engine, slug);
      expect({ calls: calls.length, failed: result.pages_failed, nonExtractable: result.pages_marked_non_extractable, cleaned: result.orphan_facts_cleaned,
        facts: (await factsOf(brain.engine, slug)).map(f => f.id) }).toEqual({ calls: 0, failed: 1, nonExtractable: 0, cleaned: 0, facts: before });
    } finally {
      spy.mockRestore();
    }
    const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = (check.details as { groups: Array<{ pipeline: string; kind: string; samples: string[]; remedy: string | null }> }).groups;
    const group = groups.find(g => g.pipeline === 'conversation_facts' && g.kind === 'no_messages');
    expect({ listed: group?.samples.includes(`default:${slug}`), fault: group?.remedy?.includes('parser fault') }).toEqual({ listed: true, fault: true });
  }, 600_000);

  test('N1: a transcript whose grammar the whole page no longer shows (references added, title changed) keeps every fact, settles nothing and leaves a grammar_lost receipt doctor lists', async () => {
    const brain = opts.getBrain();
    const slug = `notes/grammar-lost-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const transcript = sparseTranscript(3000, 18);
    await brain.seed(slug, chatPage('Grammar lost', transcript));
    const first = await extract(brain.engine, slug);
    const before = (await factsOf(brain.engine, slug)).map(f => f.id);
    expect({ processed: first.result.pages_processed, facts: before.length > 100 }).toEqual({ processed: 1, facts: true });
    await brain.seed(slug, chatPage('Grammar lost, renamed', `${transcript}\n\n## References\n\n${references(3000)}`));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    const truth = (await brain.body(slug)).truth;
    expect(parser.parseConversation(truth, { page }).matched_pattern_id).toBeUndefined();
    const { calls, result } = await extract(brain.engine, slug);
    expect({ calls: calls.length, failed: result.pages_failed, nonExtractable: result.pages_marked_non_extractable, cleaned: result.orphan_facts_cleaned,
      facts: (await factsOf(brain.engine, slug)).map(f => f.id), states: [...new Set((await derivations(brain.engine, slug)).states)] })
      .toEqual({ calls: 0, failed: 1, nonExtractable: 0, cleaned: 0, facts: before, states: ['done'] });
    const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = (check.details as { groups: Array<{ pipeline: string; kind: string; samples: string[]; remedy: string | null }> }).groups;
    const group = groups.find(g => g.pipeline === 'conversation_facts' && g.kind === 'grammar_lost');
    expect({ listed: group?.samples.includes(`default:${slug}`), remedy: group?.remedy?.includes('still parse') }).toEqual({ listed: true, remedy: true });
  }, 600_000);

  test('N2: an append_page that commits right after the old version check (before the publication locks the page) leaves the run unsettled with its facts kept; the next run settles it', async () => {
    const brain = opts.getBrain();
    const slug = `notes/concurrent-append-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Concurrent append', chatDays(4400, 100, 37)));
    await extract(brain.engine, slug);
    // Two new days: one or two new windows, fewer than a checkpoint, so the only publication after them is the final one.
    expect(await brain.call('append_page', { slug, text: chatDays(4500, 2, 37), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const before = (await factsOf(brain.engine, slug)).map(f => f.id);
    let armed = false;
    let injected = 0;
    const transaction = brain.engine.transaction;
    // The outermost transaction the publication opens (a transaction engine inherits the spy; its nested calls are skipped).
    const spy = spyOn(brain.engine, 'transaction').mockImplementation((async function (this: BrainEngine, ...args: Parameters<BrainEngine['transaction']>) {
      if (armed && this === brain.engine && (new Error().stack ?? '').includes('maintenanceTransaction')) {
        armed = false;
        injected++;
        expect(await brain.call('append_page', { slug, text: chatDays(4502, 1, 37), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
      }
      return transaction.apply(this, args);
    }) as typeof brain.engine.transaction);
    let run: Awaited<ReturnType<typeof extract>>;
    try {
      run = await extract(brain.engine, slug, { failOn: () => { armed = true; return false; } });
    } finally {
      spy.mockRestore();
    }
    const kept = await factsOf(brain.engine, slug);
    expect({ injected, calls: run.calls.length > 0, failed: run.result.pages_failed, processed: run.result.pages_processed, cleaned: run.result.orphan_facts_cleaned,
      lost: before.filter(id => !kept.some(f => f.id === id)).length, reason: run.result.failed_pages[0]?.error ?? null })
      .toEqual({ injected: 1, calls: true, failed: 1, processed: 0, cleaned: 0, lost: 0, reason: 'the page changed during extraction; left unfinished for replay' });
    const next = await extract(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ calls: next.calls.length > 0, processed: next.result.pages_processed, mismatches: await claimMismatches(brain.engine, slug), states: [...new Set(rows.states)],
      facts: (await factsOf(brain.engine, slug)).length }).toEqual({ calls: true, processed: 1, mismatches: [], states: ['done'], facts: rows.keys.length });
  }, 600_000);
}
