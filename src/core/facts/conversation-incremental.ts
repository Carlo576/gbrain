/**
 * Incremental conversation facts for a segmented page (wave-b spec 8.1, 8.2 "Conversation facts", 8.3; PR 4 lane 4b).
 *
 * Windows are packed inside one occurrence (segments cut at message lines and day headers; a gap group never spans a
 * cut). Each window's facts carry its anchor in facts.source_window (occurrence, ordinal, rendered-text sha). Per
 * occurrence, a page_segment_derivations row (kind conversation_facts) records the segment sha, a context hash (the
 * occurrence's conversation entry state plus every page-level input the windows depend on: title, gap setting, date
 * context, extraction model, --since) and the window keys it produced. A run then:
 *   - extracts only the windows of new, rewritten or context-changed occurrences, newest first, each one reserved
 *     against the page's spend cap (reservePageSpend, facts:<model>) before the call;
 *   - keeps every fact whose window is still live (its row and id are untouched);
 *   - clears the facts of windows no live occurrence produces any more (retired occurrences, rewritten tails), and the
 *     page's unanchored facts from older full-pass runs once every live occurrence is settled;
 *   - reads only the text of the occurrences it extracts (one segment at a time), never the whole body.
 * A title or gap change re-extracts every window (documented cost); a no-op rewrite extracts nothing. An occurrence a
 * run stops inside (--segment-limit, the spend cap) is stored as partial with the windows it finished, and the next
 * run resumes after them. Unmanaged brains only: a managed brain keeps the receipted whole-page publication.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { deriveDateContext, parseConversation } from '../conversation-parser/parse.ts';
import { writeDerivedFacts } from '../persistence/derived-facts.ts';
import { reservationCostUsd } from '../budget/reservation-cost.ts';
import { reservePageSpend, spendGrant } from '../page-embedding-budget.ts';
import { setExtractionReceipt } from '../extraction-watermark.ts';
import { planSegmentDerivations, segmentDerivationContextHash, sourceWindowFor, sourceWindowKey, type SegmentDerivationInput,
  type SegmentDerivationRow, type SourceWindow } from '../page-body/derivations.ts';
import { readConversationOccurrences, readOccurrenceText, type ConversationOccurrence } from '../page-body/segment-conversation.ts';
import type { SegmentedBody } from '../page-body/read-range.ts';
import { emptySaveTimeResolutionCounts, mergeSaveTimeResolutionCounts } from '../entities/resolve-on-save.ts';
import { conversationEntityHints } from './conversation-entity-hints.ts';
import { publishConversationFacts, type ConversationFactRow } from './conversation-publication.ts';
import { recordFailedPage } from './conversation-run-status.ts';
import type { ConversationSegment } from './conversation-types.ts';
import { MAX_PAGE_SEGMENT_GAP_MINUTES, renderSegmentForExtraction, splitIntoSegments } from './conversation-windows.ts';
import { extractConversationWindow, nonExtractableAuditFact, regularPageVersionToken, terminalAuditFact, type ConversationWindowRun } from './conversation-window-extract.ts';
import { getFactsExtractionMaxTokens, resolveFactsExtractionModel } from './extract.ts';

const KIND = 'conversation_facts';
/** Bump when the windowing or the row output changes shape: every occurrence is extracted again once. */
export const CONVERSATION_FACTS_DERIVATION_VERSION = 1;
/** Rough characters per token for a reservation estimate, and the system prompt and header overhead per call. */
const CHARS_PER_TOKEN = 4;
const PROMPT_OVERHEAD_TOKENS = 1500;
/** Per-1M-token rates for a model without a price: the reservation must still bound the spend. */
const UNPRICED_CHAT_RATE = { input: 15, output: 75 };

/** The run counters this pass moves (a subset of ExtractConversationFactsResult). */
export interface SegmentedConversationCounters {
  pages_considered: number; pages_processed: number; pages_skipped: number; pages_skipped_insufficient_turns: number;
  pages_marked_non_extractable: number; pages_failed: number; segments_processed: number; facts_extracted: number;
  facts_inserted: number; orphan_facts_cleaned: number; fallback_slugify_count: number; resolution_errors: number;
  failed_pages: Array<{ slug: string; error: string }>;
}

export interface SegmentedConversationRun extends ConversationWindowRun {
  result: SegmentedConversationCounters;
  dryRun: boolean;
  sleepMs: number;
  /** At most this many windows per page per run (0: no limit). */
  segmentLimit: number;
}

/** One window of an occurrence: what the extractor reads and its anchor. */
interface OccurrenceWindow { seg: ConversationSegment; text: string; window: SourceWindow }
/** A window an occurrence row records: its ordinal, rendered-text sha and how many facts it produced. */
interface WindowRecord { ordinal: number; sha: string; facts: number }

/** The bounded output a conversation_facts row stores (window anchors and counts; never text). */
function windowRecords(row: SegmentDerivationRow | undefined): WindowRecord[] {
  const windows = (row?.output as { windows?: unknown } | null)?.windows;
  return Array.isArray(windows) ? windows as WindowRecord[] : [];
}

const keyOf = (occurrenceId: number, w: WindowRecord) => sourceWindowKey({ occurrence_id: occurrenceId, window_ordinal: w.ordinal, window_text_sha: w.sha });

/** Every page-level input the windows of an occurrence depend on (the context hash's \`page\` part). */
async function conversationContext(engine: BrainEngine, page: Page, gapMinutes: number | null, sinceIso: string | undefined) {
  const dates = deriveDateContext({ page });
  const model = (await resolveFactsExtractionModel(engine)).model;
  return { model, inputs: { title: page.title || page.slug, gap_minutes: gapMinutes, date: dates.fallbackDate, timezone: dates.timezone ?? null, model, since: sinceIso ?? null } };
}

/** The windows of one occurrence: its own text parsed alone (with the date context its entry state carries in) and packed under the window caps. */
async function occurrenceWindows(engine: BrainEngine, body: SegmentedBody, occurrence: ConversationOccurrence, page: Page,
  opts: { gapMinutes: number | null; sinceIso?: string }): Promise<OccurrenceWindow[]> {
  const text = await readOccurrenceText(engine, body, occurrence.row);
  const fallbackDate = occurrence.conversation?.fallbackDate ?? undefined;
  const parsed = parseConversation(text, { page, ...(fallbackDate ? { fallbackDate } : {}) });
  const gapMinutes = opts.gapMinutes ?? (parsed.matched_pattern_id === 'email-thread-heading' ? MAX_PAGE_SEGMENT_GAP_MINUTES : undefined);
  const pageTitle = page.title || page.slug;
  return splitIntoSegments(parsed.messages, { gapMinutes, sinceIso: opts.sinceIso, pageTitle }).map((seg, ordinal) => {
    const rendered = renderSegmentForExtraction(pageTitle, seg);
    return { seg, text: rendered, window: sourceWindowFor(occurrence.row.occurrenceId, ordinal, rendered) };
  });
}

/** What one extractor call may cost at most: the prompt estimate plus the full output ceiling. */
function windowEstimateUsd(model: string, text: string, maxTokens: number): number {
  const input = Math.ceil(text.length / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS;
  return reservationCostUsd(model, 'chat', input, maxTokens) ?? (input * UNPRICED_CHAT_RATE.input + maxTokens * UNPRICED_CHAT_RATE.output) / 1_000_000;
}

/**
 * One segmented page's conversation facts, incrementally (module doc). \`gapMinutes\` is the page's own
 * conversation_segment_gap_minutes (null: the default). Returns the end of the newest window it extracted.
 */
export async function processSegmentedConversationPage(run: SegmentedConversationRun, page: Page,
  opts: { gapMinutes: number | null; sinceIso?: string }): Promise<{ newestEnd: string | null }> {
  const { engine, sourceId, result } = run;
  result.pages_considered++;
  const versionToken = regularPageVersionToken(page);
  const { model, inputs } = await conversationContext(engine, page, opts.gapMinutes, opts.sinceIso);
  const { body, occurrences } = await readConversationOccurrences(engine, page.id);
  const live = occurrences.map(o => ({ occurrenceId: o.row.occurrenceId, sha256: o.row.sha256,
    contextHash: segmentDerivationContextHash(KIND, { entryState: { region: o.row.region, conversation: o.conversation }, page: inputs }) }));
  const prior = await engine.readSegmentDerivations(page.id, { kind: KIND });
  const plan = planSegmentDerivations(KIND, CONVERSATION_FACTS_DERIVATION_VERSION, live, prior);
  const priorRow = new Map(prior.map(row => [row.occurrenceId, row]));
  const todo = new Map(plan.todo.map(segment => [segment.occurrenceId, segment]));
  // Windows of retired occurrences by (context, rendered-text sha): a rewritten tail re-cut under a new occurrence id
  // brings most of its windows back verbatim, and those keep their facts, re-anchored, instead of a new call.
  const retiredWindows = new Map<string, { occurrenceId: number; record: WindowRecord }>();
  for (const row of plan.retired) {
    if (row.version !== CONVERSATION_FACTS_DERIVATION_VERSION) continue;
    for (const record of windowRecords(row)) retiredWindows.set(`${Buffer.from(row.contextHash).toString('hex')}:${record.sha}`, { occurrenceId: row.occurrenceId, record });
  }
  const moves: Array<{ from: string; to: SourceWindow }> = [];

  const maxTokens = await getFactsExtractionMaxTokens(engine);
  const entityHints = todo.size && !run.dryRun ? await conversationEntityHints(engine, sourceId, page.slug, run.factVisibility) : undefined;
  const resolution = emptySaveTimeResolutionCounts();
  const rows: ConversationFactRow[] = [];
  const windows: SourceWindow[] = [];
  const derived = new Map<number, SegmentDerivationInput>();
  let extractedWindows = 0;
  const extractedKeys = new Set<string>();
  let stop: 'segment_limit' | 'cap_reached' | null = null;
  let newestEnd: string | null = null;
  // Newest occurrences first, and newest windows first inside each, so a cap or a limit spends on the newest messages.
  for (const occurrence of [...occurrences].reverse()) {
    const segment = todo.get(occurrence.row.occurrenceId);
    if (!segment || stop) continue;
    // A window the occurrence's stored row already extracted under the same context (a partial run, or a tail rewrite
    // that left it intact) keeps its facts: same ordinal and rendered-text sha.
    const old = priorRow.get(segment.occurrenceId);
    const reusable = old && old.version === CONVERSATION_FACTS_DERIVATION_VERSION && Buffer.from(old.contextHash).equals(Buffer.from(segment.contextHash));
    const done = new Map((reusable ? windowRecords(old) : []).map(w => [w.ordinal, w]));
    const all = await occurrenceWindows(engine, body, occurrence, page, opts);
    for (const w of [...all].reverse()) {
      const record = done.get(w.window.window_ordinal);
      if (record?.sha === w.window.window_text_sha) continue;
      const moved = retiredWindows.get(`${Buffer.from(segment.contextHash).toString('hex')}:${w.window.window_text_sha}`);
      if (moved) {
        retiredWindows.delete(`${Buffer.from(segment.contextHash).toString('hex')}:${w.window.window_text_sha}`);
        moves.push({ from: keyOf(moved.occurrenceId, moved.record), to: w.window });
        done.set(w.window.window_ordinal, { ordinal: w.window.window_ordinal, sha: w.window.window_text_sha, facts: moved.record.facts });
        continue;
      }
      if (run.segmentLimit > 0 && extractedWindows >= run.segmentLimit) { stop = 'segment_limit'; break; }
      if (run.signal?.aborted) throw new Error('aborted');
      if (run.dryRun) { extractedWindows++; continue; }
      const decision = await reservePageSpend(engine, page, `facts:${model}`, windowEstimateUsd(model, w.text, maxTokens));
      if (decision.kind === 'refused') { stop = 'cap_reached'; break; }
      const out = await spendGrant(decision.kind === 'grant' ? decision.grant : undefined,
        () => extractConversationWindow(run, page, w.seg, w.text, 0, entityHints));
      extractedWindows++;
      result.segments_processed++;
      result.facts_extracted += out.extracted;
      mergeSaveTimeResolutionCounts(resolution, out.resolution);
      for (const row of out.rows) { rows.push(row); windows.push(w.window); }
      done.set(w.window.window_ordinal, { ordinal: w.window.window_ordinal, sha: w.window.window_text_sha, facts: out.extracted });
      extractedKeys.add(sourceWindowKey(w.window));
      if (!newestEnd || w.seg.endIso > newestEnd) newestEnd = w.seg.endIso;
      if (run.sleepMs > 0) await new Promise(resolve => setTimeout(resolve, run.sleepMs));
    }
    const finished = all.every(w => done.get(w.window.window_ordinal)?.sha === w.window.window_text_sha);
    const kept = all.flatMap(w => { const r = done.get(w.window.window_ordinal); return r?.sha === w.window.window_text_sha ? [r] : []; });
    derived.set(segment.occurrenceId, { pageId: page.id, kind: KIND, occurrenceId: segment.occurrenceId, version: CONVERSATION_FACTS_DERIVATION_VERSION,
      segmentSha256: segment.sha256, contextHash: segment.contextHash, state: finished ? 'done' : 'partial', output: { windows: kept },
      receipt: finished ? null : { kind: 'unread_windows', pipeline: KIND, reason: stop, windows_read: kept.length, windows_total: all.length } });
  }
  result.fallback_slugify_count += resolution.fallback_slugify_count;
  result.resolution_errors += resolution.resolution_errors;
  if (run.dryRun) {
    result.pages_processed++;
    return { newestEnd: null };
  }

  // Window keys whose facts stay: every live occurrence's newest row (this run's, else the stored one), minus the
  // windows extracted again this run (their earlier facts give way to the new ones).
  const liveIds = live.map(segment => segment.occurrenceId);
  const liveKeys = liveIds.flatMap(id => windowRecords((derived.get(id) ?? priorRow.get(id)) as SegmentDerivationRow | undefined).map(w => keyOf(id, w)));
  const keep = liveKeys.filter(key => !extractedKeys.has(key));
  const settled = liveIds.every(id => derived.has(id) ? derived.get(id)!.state === 'done' : !todo.has(id));
  const current = await engine.getPage(page.slug, { sourceId });
  const unchanged = !!current && current.id === page.id && regularPageVersionToken(current) === versionToken;
  const outcome = !settled || !unchanged ? null : liveKeys.length
    ? terminalAuditFact(page.slug, 0, versionToken) : nonExtractableAuditFact(page.slug, 0, versionToken, 'fewer than two eligible messages');
  const published = await writeDerivedFacts(engine, sourceId, page.slug, async db => {
    const out = await publishConversationFacts(db, sourceId, page.slug, outcome ? [...rows, outcome] : rows,
      { scope: 'window', segments: { windows, moves, keep: unchanged ? keep : [...keep, ...plan.retired.flatMap(row => windowRecords(row).map(w => keyOf(row.occurrenceId, w)))], retireUnanchored: settled && unchanged } });
    if (derived.size) await db.upsertSegmentDerivations([...derived.values()]);
    if (unchanged) await db.retireSegmentDerivations(page.id, liveIds, { kind: KIND });
    return out;
  });
  await setExtractionReceipt(engine, page.id, KIND, null);
  result.facts_inserted += published.facts_inserted;
  result.orphan_facts_cleaned += published.deleted;
  if (!unchanged) {
    process.stderr.write(`[extract-conversation-facts] ${page.slug} changed during extraction; its finished windows were kept, the rest wait for the next run\n`);
    result.pages_failed++;
    recordFailedPage(result, page.slug, 'the page changed during extraction; left unfinished for replay');
    return { newestEnd: null };
  }
  if (outcome && !liveKeys.length) { result.pages_skipped++; result.pages_skipped_insufficient_turns++; result.pages_marked_non_extractable++; }
  else result.pages_processed++;
  process.stderr.write(`[extract-conversation-facts] ${page.slug}: ${published.facts_inserted} facts inserted across ${extractedWindows} new window(s) `
    + `(${plan.todo.length} of ${live.length} occurrence(s) to extract, ${plan.retired.length} retired)${stop ? `; stopped: ${stop}` : ''}\n`);
  return { newestEnd };
}
