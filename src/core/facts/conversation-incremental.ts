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
 *   - counts a window whose extraction throws (a per-window error: not an abort, a cap or a provider-wide failure such
 *     as an auth error or a rate limit) against it across runs; the run stops there, and once a window has failed
 *     WINDOW_FAILURE_LIMIT runs it is marked failed (facts 0, a failed_windows receipt doctor lists) and the run moves on
 *     to older windows; a --force run (retryFailed) tries failed windows again;
 *   - clears facts only when that is safe: an unsettled run clears the facts of windows it extracted again and of
 *     earlier windows whose messages (by position: occurrence and ordinal, never by timestamp, which a transcript
 *     without per-message times shares across every message) a run of current windows covers, nothing else; a settled run (every live window
 *     extracted, no --since, the page unchanged) clears the facts of windows that left the page and the unanchored
 *     facts of older full-pass runs, and stamps the page complete.
 * A --since run extracts only the windows after it and never settles the page. A title or gap change re-extracts every
 * window (documented cost); a no-op rewrite extracts nothing. Unmanaged brains only: a managed brain keeps the
 * receipted whole-page publication.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { deriveDateContext } from '../conversation-parser/parse.ts';
import { BudgetExhausted, loadPricingOverrides, type PricingOverrides } from '../budget/budget-tracker.ts';
import { classifyGlobalLlmError } from '../ai/errors.ts';
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
import { startsConversationRun, streamConversationWindows, type MessagePosition } from './conversation-stream.ts';
import type { ConversationSegment } from './conversation-types.ts';
import { renderSegmentForExtraction } from './conversation-windows.ts';
import { extractConversationWindow, nonExtractableAuditFact, regularPageVersionToken, terminalAuditFact, type ConversationWindowRun } from './conversation-window-extract.ts';
import { getFactsExtractionMaxTokens, resolveFactsExtractionModel, type ExtractInput } from './extract.ts';
import type { FactVisibility } from './visibility.ts';

const KIND = 'conversation_facts';
/** Bump when the windowing or the row output changes shape: every occurrence is extracted again once. */
export const CONVERSATION_FACTS_DERIVATION_VERSION = 1;
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

/** Where a window's first and last message start: [occurrence id, ordinal, occurrence id, ordinal] (MessagePosition). */
type Span = [number, number, number, number];
/** A window an occurrence row records: ordinal, rendered-text sha, facts produced, its span, and why it failed when it did. */
interface WindowRecord { ordinal: number; sha: string; facts: number; span?: Span; failed?: WindowFailure }
/** Failed extraction attempts of one window (by rendered-text sha) and the last error. */
interface WindowFailure { attempts: number; error: string }
interface RowOutput { windows: WindowRecord[]; starts_group?: boolean; prev?: number | null; pattern?: string | null; retries?: Array<{ sha: string } & WindowFailure> }
/** One window of the stream: `reused` (an earlier run's facts stand), `todo`, `extracted` by this run, or `failed` past the limit. */
interface StreamWindow { owner: number; seg: ConversationSegment; text: string | null; window: SourceWindow; span: Span;
  state: 'reused' | 'todo' | 'extracted' | 'failed'; facts: number; failed?: WindowFailure }
type Stop = 'segment_limit' | 'cap_reached' | 'interrupted' | null;

/** The bounded output a conversation_facts row stores (window anchors and counts; never text). */
function rowOutput(row: SegmentDerivationRow | undefined): RowOutput {
  const output = row?.output as Partial<RowOutput> | null | undefined;
  return { windows: Array.isArray(output?.windows) ? output.windows : [], starts_group: output?.starts_group, prev: output?.prev,
    pattern: output?.pattern ?? null, retries: Array.isArray(output?.retries) ? output.retries : [] };
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
function coveredKeys(windows: readonly StreamWindow[], earlier: ReadonlyArray<{ key: string; span?: Span }>, place: ReadonlyMap<number, number>): string[] {
  const at = (occurrenceId: number, n: number) => { const p = place.get(occurrenceId); return p === undefined ? null : p * 1_000_000_000 + n; };
  const runs: Array<[number, number]> = [];
  let open: [number, number] | null = null;
  for (const w of windows) {
    if (w.state !== 'reused' && w.state !== 'extracted') { open = null; continue; }
    const start = at(w.span[0], w.span[1])!;
    const end = at(w.span[2], w.span[3])!;
    if (open) open[1] = end;
    else runs.push(open = [start, end]);
  }
  return earlier.filter(e => {
    const start = e.span ? at(e.span[0], e.span[1]) : null;
    const end = e.span ? at(e.span[2], e.span[3]) : null;
    return start !== null && end !== null && runs.some(([a, b]) => a <= start && end <= b);
  }).map(e => e.key);
}

/** Whether a window's extraction error counts against the window: not an abort, a cap, or a provider-wide failure. */
const windowFailure = (error: unknown, signal: AbortSignal | undefined) =>
  !signal?.aborted && !(error instanceof BudgetExhausted) && !(error instanceof Error && error.name === 'AbortError') && classifyGlobalLlmError(error) === null;

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
  const earlier: Array<{ key: string; span?: Span }> = [];
  const failures = new Map<string, WindowFailure>();
  let pattern = prior.map(row => rowOutput(row).pattern).find(Boolean) ?? null;
  for (const row of prior) {
    if ((position.get(row.occurrenceId) ?? Infinity) < from) continue;
    const same = row.version === CONVERSATION_FACTS_DERIVATION_VERSION && hex(row.contextHash) === hex(contextHash);
    const output = rowOutput(row);
    for (const record of output.windows) {
      earlier.push({ key: keyOf(row.occurrenceId, record), span: record.span });
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
  const streamOpts = { page, gapMinutes: opts.gapMinutes, sinceIso: opts.sinceIso, pattern };
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
    const spanOf = (first: MessagePosition, last: MessagePosition): Span => [liveIds[first.owner]!, first.n, liveIds[last.owner]!, last.n];
    pattern = streamOpts.pattern = await streamConversationWindows(occurrences, start, end, streamOpts, readText, {
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
    const owned = new Map<number, StreamWindow[]>();
    for (const w of windows) owned.set(w.owner, [...(owned.get(w.owner) ?? []), w]);
    // Rows of the occurrences this run finished or reached; an occurrence it never reached keeps its row (still unsettled).
    const derived: SegmentDerivationInput[] = liveIds.slice(streamedFrom).flatMap((occurrenceId, k) => {
      const mine = owned.get(occurrenceId) ?? [];
      const records: WindowRecord[] = mine.filter(w => w.state !== 'todo').map(w => ({ ordinal: w.window.window_ordinal, sha: w.window.window_text_sha,
        facts: w.facts, span: w.span, ...(w.failed && w.state === 'failed' ? { failed: w.failed } : {}) }));
      const retries = mine.flatMap(w => { const failure = w.state === 'todo' ? failures.get(w.window.window_text_sha) : undefined; return failure ? [{ sha: w.window.window_text_sha, ...failure }] : []; });
      const failed = records.filter(r => r.failed).map(r => ({ ordinal: r.ordinal, ...r.failed! }));
      const finished = records.length === mine.length;
      if (!finished && !records.length && occurrenceId !== stopOwner) return [];
      return [{ pageId: page.id, kind: KIND, occurrenceId, version: CONVERSATION_FACTS_DERIVATION_VERSION, segmentSha256: live[streamedFrom + k]!.sha256,
        contextHash, state: finished && !opts.sinceIso ? 'done' : 'partial',
        output: { windows: records, starts_group: startsGroup.get(occurrenceId) ?? false, prev: prevOf(streamedFrom + k), pattern, ...(retries.length ? { retries } : {}) },
        receipt: !finished ? { kind: 'unread_windows', pipeline: KIND, reason: stop ?? 'in_progress', windows_read: records.length, windows_total: mine.length }
          : failed.length ? { kind: 'failed_windows', pipeline: KIND, windows: failed } : null }];
    });
    const keep = settled ? [...liveIds.slice(0, from).flatMap(id => rowOutput(priorRow.get(id)).windows.map(w => keyOf(id, w))),
      ...windows.map(w => sourceWindowKey(w.window))] : null;
    const clear = settled ? [] : [...batch.keys, ...coveredKeys(windows, earlier.filter(e => !reused.has(e.key)), position).filter(key => !cleared.has(key))];
    const outcome = !settled ? null : keep!.length ? terminalAuditFact(page.slug, 0, versionToken)
      : nonExtractableAuditFact(page.slug, 0, versionToken, 'fewer than two eligible messages');
    const moves = [...pendingMoves];
    const out = await writeDerivedFacts(engine, sourceId, page.slug, async db => {
      const published = await publishConversationFacts(db, sourceId, page.slug, outcome ? [...batch.rows, outcome] : batch.rows,
        { scope: 'window', segments: { windows: batch.windows, moves, keep, clear, retireUnanchored: settled } });
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
          Object.assign(w, { state: 'failed', failed: failure, text: null });
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
