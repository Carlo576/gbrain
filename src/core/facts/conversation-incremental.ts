/**
 * Incremental conversation facts for a segmented page (wave-b spec 8.1, 8.2 "Conversation facts", 8.3; PR 4 lane 4b).
 *
 * Windows run over message boundaries across occurrences (conversation-stream.ts), so a window can span a segment cut;
 * each window belongs to the occurrence its first message starts in. Each window's facts carry its anchor in
 * facts.source_window (owner occurrence, ordinal, rendered-text sha). Per occurrence, a page_segment_derivations row
 * (kind conversation_facts) records the segment sha, a context hash (every page-level input the windows depend on:
 * title, gap setting, date context, extraction model, effective fact visibility), the windows it owns (ordinal, sha,
 * facts, the positions of its first and last message), its predecessor, whether its first message opens a gap group,
 * the grammar the page was parsed under, and the failed attempts of windows not extracted yet. A run:
 *   - finds the first occurrence that is new, rewritten, moved or context-changed and streams the windows from the
 *     nearest earlier occurrence that opens a gap group (the windows before it cannot change), one segment at a time
 *     and in runs, newest run first (a run ends where the next occurrence certainly opens a gap group), so a stop
 *     reads only the runs it reached; a page nothing changed on reads nothing;
 *   - reuses every window an earlier run extracted with the same rendered text under the same context (re-anchored
 *     when it moved), so an append extracts only its new windows and the one it grew;
 *   - extracts the rest newest first, each call metered against the page's facts cap (meterPaidCall, facts:<model>,
 *     reserved for every attempt and booked at the provider-reported cost), and publishes the facts and rows every
 *     CONVERSATION_FACTS_CHECKPOINT_WINDOWS windows, when it stops (--segment-limit, the cap) and when a window throws
 *     or the run aborts, so finished windows are never paid for twice;
 *   - counts a window whose extraction fails for a reason of its own (malformed or truncated output, a refusal or
 *     content filter, a provider refusal of the window's own input such as a context-length error; never a transport,
 *     provider, auth, rate-limit, 5xx, timeout or abort failure) against it across runs; the run stops there, and once a
 *     window has failed WINDOW_FAILURE_LIMIT runs it is marked failed (facts 0, a failed_windows receipt doctor lists)
 *     and the run moves on to older windows; a failed window keeps the facts of the earlier windows it overlaps until it
 *     is extracted, and a --force run (retryFailed) tries it again;
 *   - parses under the grammar a current row recorded, else the one the page's head detects (as the whole-page pass
 *     picks it), never one recorded under another context or text; a stream that parses no message from occurrences
 *     that had windows clears nothing and settles nothing (a no_messages receipt, the page counted failed);
 *   - clears facts only when that is safe: an unsettled run clears the facts of windows it extracted again and of
 *     earlier windows whose messages (by position: occurrence, ordinal and piece of an oversized message, never by
 *     timestamp, which a transcript without per-message times shares across every message) a run of current windows
 *     covers, nothing else; a settled run (every live window
 *     extracted, no --since, the page unchanged) clears the facts of windows that left the page and the unanchored
 *     facts of older full-pass runs, and stamps the page complete.
 * A --since run extracts only the windows after it and never settles the page. A title or gap change re-extracts every
 * window (documented cost); a no-op rewrite extracts nothing. Unmanaged brains only: a managed brain keeps the
 * receipted whole-page publication.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { deriveDateContext } from '../conversation-parser/parse.ts';
import { loadPricingOverrides, type PricingOverrides } from '../budget/budget-tracker.ts';
import { providerItemRefusal } from '../ai/errors.ts';
import { truthLead } from '../page-body/segment-blocks.ts';
import { writeDerivedFacts } from '../persistence/derived-facts.ts';
import { estimateFactsExtractionUsd, meterPaidCall } from '../page-embedding-budget.ts';
import { setExtractionReceipt } from '../extraction-watermark.ts';
import { planSegmentDerivations, segmentDerivationContextHash, sourceWindowFor, sourceWindowKey, type SegmentDerivationInput,
  type SegmentDerivationRow, type SourceWindow } from '../page-body/derivations.ts';
import { readConversationOccurrences, readOccurrenceText } from '../page-body/segment-conversation.ts';
import { emptySaveTimeResolutionCounts, mergeSaveTimeResolutionCounts } from '../entities/resolve-on-save.ts';
import { conversationEntityHints } from './conversation-entity-hints.ts';
import { publishConversationFacts, type ConversationFactRow } from './conversation-publication.ts';
import { recordFailedPage } from './conversation-run-status.ts';
import { detectConversationPattern, startsConversationRun, streamConversationWindows, type MessagePosition } from './conversation-stream.ts';
import type { ConversationSegment } from './conversation-types.ts';
import { renderSegmentForExtraction } from './conversation-windows.ts';
import { extractConversationWindow, nonExtractableAuditFact, regularPageVersionToken, terminalAuditFact, type ConversationWindowRun } from './conversation-window-extract.ts';
import { getFactsExtractionMaxTokens, resolveFactsExtractionModel, type ExtractInput } from './extract.ts';
import type { FactVisibility } from './visibility.ts';

const KIND = 'conversation_facts';
/** Bump when the windowing or the row output changes shape: every occurrence is extracted again once. */
export const CONVERSATION_FACTS_DERIVATION_VERSION = 2;
/** Windows extracted between two publications of a page's facts and rows. */
export const CONVERSATION_FACTS_CHECKPOINT_WINDOWS = 8;
/**
 * Runs in which one window's extraction may throw before it is marked failed and skipped. extract.ts already retries a
 * truncated or malformed answer inside one run and the gateway retries transient provider errors, so a window that
 * still throws in three separate runs fails for a reason of its own (its text, a deterministic provider refusal); three
 * also rides out a transient outage spanning two runs, and bounds what a doomed window costs at three reservations.
 */
export const WINDOW_FAILURE_LIMIT = 3;

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

/** Characters of the page's head the grammar is detected from when no current row records it. */
const PATTERN_HEAD_CHARS = 64 * 1024;
/** Where a window's first and last message piece are: [occurrence id, ordinal, piece] twice (MessagePosition). */
type Span = [number, number, number, number, number, number];
/** A window an occurrence row records: ordinal, rendered-text sha, facts produced, its span, and why it failed when it did. */
interface WindowRecord { ordinal: number; sha: string; facts: number; span?: Span; failed?: WindowFailure }
/** Failed extraction attempts of one window (by rendered-text sha), the last error, and (once failed) the keys of the earlier windows whose facts it keeps. */
interface WindowFailure { attempts: number; error: string; keeps?: string[] }
/** An earlier window whose facts still stand though no current window holds it yet (an unsettled run left it): its key and span. */
interface StaleWindow { key: string; span?: Span }
interface RowOutput { windows: WindowRecord[]; starts_group?: boolean; prev?: number | null; pattern?: string | null; retries?: Array<{ sha: string } & WindowFailure>;
  stale?: StaleWindow[] }
/** One window of the stream: `reused` (an earlier run's facts stand), `todo`, `extracted` by this run, or `failed` past the limit. */
interface StreamWindow { owner: number; seg: ConversationSegment; text: string | null; window: SourceWindow; span: Span;
  state: 'reused' | 'todo' | 'extracted' | 'failed'; facts: number; failed?: WindowFailure }
type Stop = 'segment_limit' | 'cap_reached' | 'interrupted' | null;

/** The bounded output a conversation_facts row stores (window anchors and counts; never text). */
function rowOutput(row: SegmentDerivationRow | undefined): RowOutput {
  const output = row?.output as Partial<RowOutput> | null | undefined;
  return { windows: Array.isArray(output?.windows) ? output.windows : [], starts_group: output?.starts_group, prev: output?.prev,
    pattern: output?.pattern ?? null, retries: Array.isArray(output?.retries) ? output.retries : [], stale: Array.isArray(output?.stale) ? output.stale : [] };
}

const keyOf = (occurrenceId: number, w: WindowRecord) => sourceWindowKey({ occurrence_id: occurrenceId, window_ordinal: w.ordinal, window_text_sha: w.sha });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Every page-level input the windows depend on: the context hash. */
async function conversationContext(engine: BrainEngine, page: Page, gapMinutes: number | null, visibility: FactVisibility) {
  const dates = deriveDateContext({ page });
  const model = (await resolveFactsExtractionModel(engine)).model;
  return { model, inputs: { title: page.title || page.slug, gap_minutes: gapMinutes, date: dates.fallbackDate, timezone: dates.timezone ?? null, model, visibility } };
}

/**
 * Window keys of earlier windows whose first and last message positions fall inside one run of consecutive windows
 * with facts standing (reused or extracted). A position orders by its occurrence's place on the page, then its
 * ordinal; a window in an occurrence that left the page is never covered.
 */
function coveredKeys(windows: readonly StreamWindow[], earlier: readonly StaleWindow[], place: ReadonlyMap<number, number>): string[] {
  const runs: Array<[Point, Point]> = [];
  let open: [Point, Point] | null = null;
  for (const w of windows) {
    if (w.state !== 'reused' && w.state !== 'extracted') { open = null; continue; }
    const [start, end] = ends(w.span, place) as [Point, Point];
    if (open) open[1] = end;
    else runs.push(open = [start, end]);
  }
  return earlier.filter(e => {
    const span = e.span ? ends(e.span, place) : null;
    return span !== null && runs.some(([a, b]) => before(a, span[0]) && before(span[1], b));
  }).map(e => e.key);
}

/** A message piece's place on the page: [occurrence place, ordinal, piece], ordered lexicographically. */
type Point = [number, number, number];
const before = (a: Point, b: Point) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] <= b[2];
/** A span's first and last point, or null when either occurrence left the page. */
function ends(span: Span, place: ReadonlyMap<number, number>): [Point, Point] | null {
  const first = place.get(span[0]);
  const last = place.get(span[3]);
  return first === undefined || last === undefined ? null : [[first, span[1], span[2]], [last, span[4], span[5]]];
}

/** Keys of earlier windows whose span overlaps `span` (a failed window keeps their facts). */
function overlappingKeys(span: Span, earlier: readonly StaleWindow[], place: ReadonlyMap<number, number>): string[] {
  const mine = ends(span, place);
  if (!mine) return [];
  return earlier.filter(e => {
    const theirs = e.span ? ends(e.span, place) : null;
    return theirs !== null && before(theirs[0], mine[1]) && before(mine[0], theirs[1]);
  }).map(e => e.key);
}

/** extract.ts failure reasons caused by the window itself (its output or its content), which repeat until it changes. */
const WINDOW_SPECIFIC_REASONS: ReadonlySet<string> = new Set(['malformed_output', 'truncated_output', 'refusal', 'content_filter']);

/**
 * Whether a window's extraction error counts against the window: a failure of the window's own (WINDOW_SPECIFIC_REASONS,
 * or a provider refusal of its own input such as a context-length error). A transport, provider, auth, rate-limit,
 * 5xx, timeout or abort failure, a cap, or an error with no extraction reason never counts.
 */
function windowFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return false;
  const reason = (error as { extractionReason?: unknown } | null)?.extractionReason;
  if (typeof reason !== 'string') return false;
  if (WINDOW_SPECIFIC_REASONS.has(reason)) return true;
  return reason === 'provider_error' && providerItemRefusal((error as { cause?: unknown }).cause) !== null;
}

/**
 * One segmented page's conversation facts, incrementally (module doc). `gapMinutes` is the page's own
 * conversation_segment_gap_minutes (null: the default). Returns the end of the newest window it extracted.
 */
export async function processSegmentedConversationPage(run: SegmentedConversationRun, page: Page,
  opts: { gapMinutes: number | null; sinceIso?: string; retryFailed?: boolean }): Promise<{ newestEnd: string | null }> {
  const { engine, sourceId, result } = run;
  result.pages_considered++;
  const versionToken = regularPageVersionToken(page);
  const { model, inputs } = await conversationContext(engine, page, opts.gapMinutes, run.factVisibility);
  const contextHash = segmentDerivationContextHash(KIND, { entryState: null, page: inputs });
  const { body, occurrences } = await readConversationOccurrences(engine, page.id);
  const live = occurrences.map(o => ({ occurrenceId: o.row.occurrenceId, sha256: o.row.sha256, contextHash }));
  const liveIds = live.map(segment => segment.occurrenceId);
  const prior = await engine.readSegmentDerivations(page.id, { kind: KIND });
  const plan = planSegmentDerivations(KIND, CONVERSATION_FACTS_DERIVATION_VERSION, live, prior);
  const priorRow = new Map(prior.map(row => [row.occurrenceId, row]));
  const current = new Set(plan.current.map(row => row.occurrenceId));
  const prevOf = (i: number) => (i === 0 ? null : liveIds[i - 1]!);
  const intact = (i: number) => {
    const output = rowOutput(priorRow.get(liveIds[i]!));
    return current.has(liveIds[i]!) && (output.prev ?? null) === prevOf(i) && !(opts.retryFailed && output.windows.some(w => w.failed));
  };
  // The first occurrence whose windows may have changed (one past the last when only trailing occurrences left), and
  // the nearest earlier occurrence that opens a gap group: the stream starts there.
  let first = liveIds.findIndex((_, i) => !intact(i));
  if (first < 0) first = plan.retired.length ? liveIds.length : -1;
  let from = first < 0 ? liveIds.length : 0;
  for (let i = Math.min(first, liveIds.length) - 1; i > 0; i--) {
    if (intact(i) && rowOutput(priorRow.get(liveIds[i]!)).starts_group === true) { from = i; break; }
  }
  const position = new Map(liveIds.map((id, i) => [id, i]));
  // Earlier windows of the occurrences the stream covers (and of retired ones): reusable by rendered text under the same
  // context, and candidates to clear once the current windows cover their messages.
  const reusable = new Map<string, Array<{ occurrenceId: number; record: WindowRecord }>>();
  const earlier: Array<StaleWindow & { occurrenceId: number }> = [];
  const failures = new Map<string, WindowFailure>();
  // The page's grammar: the one a current row recorded (same text, version and context), else the head's (below).
  let pattern: string | null = plan.current.map(row => rowOutput(row).pattern).find(Boolean) ?? null;
  for (const row of prior) {
    if ((position.get(row.occurrenceId) ?? Infinity) < from) continue;
    const same = row.version === CONVERSATION_FACTS_DERIVATION_VERSION && hex(row.contextHash) === hex(contextHash);
    const output = rowOutput(row);
    for (const stale of output.stale ?? []) earlier.push({ ...stale, occurrenceId: row.occurrenceId });
    for (const record of output.windows) {
      earlier.push({ key: keyOf(row.occurrenceId, record), span: record.span, occurrenceId: row.occurrenceId });
      if (same && !(record.failed && opts.retryFailed)) reusable.set(record.sha, [...(reusable.get(record.sha) ?? []), { occurrenceId: row.occurrenceId, record }]);
    }
    if (same && !opts.retryFailed) for (const { sha, attempts, error } of output.retries ?? []) failures.set(sha, { attempts, error });
  }
  const windows: StreamWindow[] = [];
  const pendingMoves: Array<{ from: string; to: SourceWindow }> = [];
  const reused = new Set<string>();
  const startsGroup = new Map<number, boolean>();
  const ordinals = new Map<number, number>();
  const pageTitle = page.title || page.slug;
  if (!pattern && from < liveIds.length) pattern = detectConversationPattern(await truthLead(engine, page.id, PATTERN_HEAD_CHARS), page);
  const streamOpts = { page, gapMinutes: opts.gapMinutes, sinceIso: opts.sinceIso, pattern };
  let parsedMessages = 0;
  const texts = new Map<number, string>();
  const readText = async (i: number) => {
    const cached = texts.get(i);
    if (cached !== undefined) return cached;
    const text = await readOccurrenceText(engine, body, occurrences[i]!.row);
    texts.set(i, text);
    return text;
  };
  /** Stream the newest run not streamed yet: from the nearest occurrence before `end` whose first message opens a gap group (module doc). */
  const streamRun = async (end: number): Promise<{ start: number; windows: StreamWindow[] }> => {
    let start = end - 1;
    while (start > from && !startsConversationRun(occurrences, start, await readText(start), await readText(start - 1), streamOpts)) start--;
    const runWindows: StreamWindow[] = [];
    const spanOf = (first: MessagePosition, last: MessagePosition): Span => [liveIds[first.owner]!, first.n, first.piece, liveIds[last.owner]!, last.n, last.piece];
    const streamed = await streamConversationWindows(occurrences, start, end, streamOpts, readText, {
      window(first, last, seg) {
        const owner = liveIds[first.owner]!;
        const ordinal = ordinals.get(owner) ?? 0;
        ordinals.set(owner, ordinal + 1);
        const text = renderSegmentForExtraction(pageTitle, seg);
        const window = sourceWindowFor(owner, ordinal, text);
        const hit = reusable.get(window.window_text_sha)?.shift();
        const span = spanOf(first, last);
        if (!hit) { runWindows.push({ owner, seg, text, window, span, state: 'todo', facts: 0 }); return; }
        const was = keyOf(hit.occurrenceId, hit.record);
        reused.add(was);
        if (was !== sourceWindowKey(window)) pendingMoves.push({ from: was, to: window });
        runWindows.push({ owner, seg, text: null, window, span, state: hit.record.failed ? 'failed' : 'reused', facts: hit.record.facts, failed: hit.record.failed });
      },
      occurrence(index, starts) { startsGroup.set(liveIds[index]!, starts); },
    });
    pattern = streamOpts.pattern = streamed.pattern;
    parsedMessages += streamed.messages;
    for (const i of [...texts.keys()]) if (i > start) texts.delete(i);
    windows.unshift(...runWindows);
    return { start, windows: runWindows };
  };
  if (run.dryRun) {
    let todo = 0;
    for (let end = liveIds.length; end > from;) { const next = await streamRun(end); todo += next.windows.filter(w => w.state === 'todo').length; end = next.start; }
    result.segments_processed += run.segmentLimit > 0 ? Math.min(todo, run.segmentLimit) : todo;
    result.pages_processed++;
    return { newestEnd: null };
  }

  const resolution = emptySaveTimeResolutionCounts();
  let streamedFrom = liveIds.length;
  let stop: Stop = null;
  let stopOwner: number | null = null;
  let newestEnd: string | null = null;
  let extracted = 0;
  let batch: { rows: ConversationFactRow[]; windows: SourceWindow[]; keys: string[] } = { rows: [], windows: [], keys: [] };
  let cleared = new Set<string>();
  let settledPage = false;
  /** Publish the facts extracted since the last publication and the rows of the streamed occurrences; `final` settles a finished page. */
  const publish = async (final: boolean) => {
    let unchanged = true;
    if (final) {
      const now = await engine.getPage(page.slug, { sourceId });
      unchanged = !!now && now.id === page.id && regularPageVersionToken(now) === versionToken;
    }
    const settled = final && unchanged && stop === null && !opts.sinceIso && streamedFrom <= from;
    const clear = settled ? [] : [...batch.keys, ...coveredKeys(windows, earlier.filter(e => !reused.has(e.key)), position).filter(key => !cleared.has(key))];
    const gone = new Set([...cleared, ...clear]);
    const owned = new Map<number, StreamWindow[]>();
    for (const w of windows) owned.set(w.owner, [...(owned.get(w.owner) ?? []), w]);
    // Rows of the occurrences this run finished or reached; an occurrence it never reached keeps its row (still unsettled).
    const derived: SegmentDerivationInput[] = liveIds.slice(streamedFrom).flatMap((occurrenceId, k) => {
      const mine = owned.get(occurrenceId) ?? [];
      const records: WindowRecord[] = mine.filter(w => w.state !== 'todo').map(w => ({ ordinal: w.window.window_ordinal, sha: w.window.window_text_sha,
        facts: w.facts, span: w.span, ...(w.failed && w.state === 'failed' ? { failed: w.failed } : {}) }));
      const retries = mine.flatMap(w => { const failure = w.state === 'todo' ? failures.get(w.window.window_text_sha) : undefined; return failure ? [{ sha: w.window.window_text_sha, ...failure }] : []; });
      const failed = records.filter(r => r.failed).map(r => ({ ordinal: r.ordinal, attempts: r.failed!.attempts, error: r.failed!.error }));
      const finished = records.length === mine.length;
      const recorded = new Set(records.map(r => keyOf(occurrenceId, r)));
      // Earlier windows of this occurrence whose facts this unsettled run neither replaced nor cleared stay on its row.
      const stale = settled ? [] : earlier.filter(e => e.occurrenceId === occurrenceId && !reused.has(e.key) && !gone.has(e.key) && !recorded.has(e.key))
        .map(({ key, span }) => ({ key, span }));
      if (!finished && !records.length && !stale.length && occurrenceId !== stopOwner) return [];
      return [{ pageId: page.id, kind: KIND, occurrenceId, version: CONVERSATION_FACTS_DERIVATION_VERSION, segmentSha256: live[streamedFrom + k]!.sha256,
        contextHash, state: finished && !opts.sinceIso ? 'done' : 'partial',
        output: { windows: records, starts_group: startsGroup.get(occurrenceId) ?? false, prev: prevOf(streamedFrom + k), pattern, ...(retries.length ? { retries } : {}), ...(stale.length ? { stale } : {}) },
        receipt: !finished ? { kind: 'unread_windows', pipeline: KIND, reason: stop ?? 'in_progress', windows_read: records.length, windows_total: mine.length }
          : failed.length ? { kind: 'failed_windows', pipeline: KIND, windows: failed } : null }];
    });
    // A failed window keeps the facts of the earlier windows it overlaps (`keeps`) until it is extracted.
    const settledWindows = [...liveIds.slice(0, from).flatMap(id => rowOutput(priorRow.get(id)).windows.map(w => ({ key: keyOf(id, w), failed: w.failed }))),
      ...windows.map(w => ({ key: sourceWindowKey(w.window), failed: w.state === 'failed' ? w.failed : undefined }))];
    const anyFailed = settledWindows.some(w => w.failed);
    const keep = settled ? settledWindows.flatMap(w => [w.key, ...(w.failed?.keeps ?? [])]) : null;
    const outcome = !settled ? null : keep!.length ? terminalAuditFact(page.slug, 0, versionToken)
      : nonExtractableAuditFact(page.slug, 0, versionToken, 'fewer than two eligible messages');
    const moves = [...pendingMoves];
    const out = await writeDerivedFacts(engine, sourceId, page.slug, async db => {
      const published = await publishConversationFacts(db, sourceId, page.slug, outcome ? [...batch.rows, outcome] : batch.rows,
        { scope: 'window', segments: { windows: batch.windows, moves, keep, clear, retireUnanchored: settled && !anyFailed } });
      if (derived.length) await db.upsertSegmentDerivations(derived);
      if (settled) await db.retireSegmentDerivations(page.id, liveIds, { kind: KIND });
      return published;
    });
    pendingMoves.splice(0, moves.length);
    cleared = new Set([...cleared, ...clear]);
    batch = { rows: [], windows: [], keys: [] };
    result.facts_inserted += out.facts_inserted;
    result.orphan_facts_cleaned += out.deleted;
    settledPage = settled;
    return { unchanged, settled, keep, outcome };
  };

  const maxTokens = await getFactsExtractionMaxTokens(engine);
  let paid: { pricingOverrides: PricingOverrides | undefined; entityHints: ExtractInput['entityHints'] } | null = null;
  try {
    // Newest runs first, and newest windows first inside each, so a cap or a limit spends on the newest messages.
    for (let end = liveIds.length; end > from && !stop;) {
      const next = await streamRun(end);
      streamedFrom = end = next.start;
      for (const w of next.windows.filter(x => x.state === 'todo').reverse()) {
        stopOwner = w.owner;
        if (run.segmentLimit > 0 && extracted >= run.segmentLimit) { stop = 'segment_limit'; break; }
        if (run.signal?.aborted) throw new Error('aborted');
        paid ??= { pricingOverrides: await loadPricingOverrides(engine), entityHints: await conversationEntityHints(engine, sourceId, page.slug, run.factVisibility) };
        const { pricingOverrides, entityHints } = paid;
        const text = w.text!;
        const sha = w.window.window_text_sha;
        let metered: Awaited<ReturnType<typeof meterPaidCall<Awaited<ReturnType<typeof extractConversationWindow>>>>>;
        try {
          metered = await meterPaidCall(engine, page, `facts:${model}`, estimateFactsExtractionUsd(model, text.length, maxTokens, pricingOverrides),
            () => extractConversationWindow(run, page, w.seg, text, 0, entityHints), { pricingOverrides });
        } catch (error) {
          if (!windowFailure(error, run.signal)) throw error;
          const failure = { attempts: (failures.get(sha)?.attempts ?? 0) + 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
          failures.set(sha, failure);
          if (failure.attempts < WINDOW_FAILURE_LIMIT) throw error;
          failures.delete(sha);
          Object.assign(w, { state: 'failed', failed: { ...failure, keeps: overlappingKeys(w.span, earlier.filter(e => !reused.has(e.key)), position) }, text: null });
          stopOwner = null;
          process.stderr.write(`[extract-conversation-facts] ${page.slug}: window ${w.window.window_ordinal} of occurrence ${w.owner} failed ${failure.attempts} runs (${failure.error}); skipped, gbrain doctor lists it, --force retries it\n`);
          continue;
        }
        if ('refused' in metered) { stop = 'cap_reached'; break; }
        const out = metered.value;
        w.state = 'extracted';
        w.facts = out.extracted;
        w.text = null;
        extracted++;
        result.segments_processed++;
        result.facts_extracted += out.extracted;
        mergeSaveTimeResolutionCounts(resolution, out.resolution);
        for (const row of out.rows) { batch.rows.push(row); batch.windows.push(w.window); }
        batch.keys.push(sourceWindowKey(w.window));
        if (!newestEnd || w.seg.endIso > newestEnd) newestEnd = w.seg.endIso;
        stopOwner = null;
        if (batch.keys.length >= CONVERSATION_FACTS_CHECKPOINT_WINDOWS) await publish(false);
        if (run.sleepMs > 0) await new Promise(resolve => setTimeout(resolve, run.sleepMs));
      }
    }
  } catch (error) {
    stop = 'interrupted';
    await publish(false).catch(publishError => {
      process.stderr.write(`[extract-conversation-facts] ${page.slug}: could not publish the finished windows: ${publishError instanceof Error ? publishError.message : String(publishError)}\n`);
    });
    throw error;
  } finally {
    result.fallback_slugify_count += resolution.fallback_slugify_count;
    result.resolution_errors += resolution.resolution_errors;
  }

  if (parsedMessages === 0 && earlier.length > 0) {
    // Occurrences that had windows parsed into no message (a changed format the grammar no longer reads, a parser
    // fault): clearing or settling would delete every fact they held. Nothing is published; the receipt says why.
    await setExtractionReceipt(engine, page.id, KIND, { kind: 'no_messages', pipeline: KIND, processed_chars: 0 });
    process.stderr.write(`[extract-conversation-facts] ${page.slug}: no message parsed from occurrences that had ${earlier.length} window(s); its facts were kept, nothing settled\n`);
    result.pages_failed++;
    recordFailedPage(result, page.slug, 'no message parsed from occurrences that had windows; facts kept for replay');
    return { newestEnd: null };
  }
  const { unchanged, keep, outcome } = await publish(true);
  await setExtractionReceipt(engine, page.id, KIND, null);
  if (!unchanged) {
    process.stderr.write(`[extract-conversation-facts] ${page.slug} changed during extraction; its finished windows were kept, the rest wait for the next run\n`);
    result.pages_failed++;
    recordFailedPage(result, page.slug, 'the page changed during extraction; left unfinished for replay');
    return { newestEnd: null };
  }
  if (outcome && !keep!.length) { result.pages_skipped++; result.pages_skipped_insufficient_turns++; result.pages_marked_non_extractable++; }
  else result.pages_processed++;
  process.stderr.write(`[extract-conversation-facts] ${page.slug}: ${extracted} new window(s) of ${windows.length} streamed from occurrence ${streamedFrom + 1} of ${liveIds.length}`
    + `${stop ? `; stopped: ${stop}` : settledPage ? '; settled' : ''}\n`);
  return { newestEnd };
}
