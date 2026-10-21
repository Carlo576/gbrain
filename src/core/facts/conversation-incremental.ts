/**
 * Incremental conversation facts for a segmented page (wave-b spec 8.1, 8.2 "Conversation facts", 8.3; PR 4 lane 4b).
 *
 * Windows run over message boundaries across occurrences (conversation-stream.ts), so a window can span a segment cut;
 * each window belongs to the occurrence its first message starts in. Each window's facts carry its anchor in
 * facts.source_window (owner occurrence, ordinal, rendered-text sha). Per occurrence, a page_segment_derivations row
 * (kind conversation_facts) records the segment sha, a context hash (every page-level input the windows depend on:
 * title, gap setting, date context, extraction model, effective fact visibility), the windows it owns (ordinal, sha,
 * facts, first and last message time), its predecessor and whether its first message opens a gap group. A run:
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
 *   - clears facts only when that is safe: an unsettled run clears the facts of windows it extracted again and of
 *     earlier windows whose messages the current windows cover, nothing else; a settled run (every live window
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
import { startsConversationRun, streamConversationWindows } from './conversation-stream.ts';
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

/** A window an occurrence row records: ordinal, rendered-text sha, facts produced, and its first and last message times. */
interface WindowRecord { ordinal: number; sha: string; facts: number; start?: string; end?: string }
interface RowOutput { windows: WindowRecord[]; starts_group?: boolean; prev?: number | null }
/** One window of the stream: `reused` (an earlier run's facts stand), `todo`, or `extracted` by this run. */
interface StreamWindow { owner: number; seg: ConversationSegment; text: string | null; window: SourceWindow; state: 'reused' | 'todo' | 'extracted'; facts: number }
type Stop = 'segment_limit' | 'cap_reached' | 'interrupted' | null;

/** The bounded output a conversation_facts row stores (window anchors and counts; never text). */
function rowOutput(row: SegmentDerivationRow | undefined): RowOutput {
  const output = row?.output as Partial<RowOutput> | null | undefined;
  return { windows: Array.isArray(output?.windows) ? output.windows : [], starts_group: output?.starts_group, prev: output?.prev };
}

const keyOf = (occurrenceId: number, w: WindowRecord) => sourceWindowKey({ occurrence_id: occurrenceId, window_ordinal: w.ordinal, window_text_sha: w.sha });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Every page-level input the windows depend on: the context hash. */
async function conversationContext(engine: BrainEngine, page: Page, gapMinutes: number | null, visibility: FactVisibility) {
  const dates = deriveDateContext({ page });
  const model = (await resolveFactsExtractionModel(engine)).model;
  return { model, inputs: { title: page.title || page.slug, gap_minutes: gapMinutes, date: dates.fallbackDate, timezone: dates.timezone ?? null, model, visibility } };
}

/** Window keys of earlier windows whose first and last message times fall inside one run of consecutive live windows. */
function coveredKeys(windows: readonly StreamWindow[], earlier: ReadonlyArray<{ key: string; start?: string; end?: string }>): string[] {
  const runs: Array<[string, string]> = [];
  let open: [string, string] | null = null;
  for (const w of windows) {
    if (w.state === 'todo') { open = null; continue; }
    if (open) open[1] = w.seg.endIso;
    else runs.push(open = [w.seg.startIso, w.seg.endIso]);
  }
  return earlier.filter(e => e.start && e.end && runs.some(([start, end]) => e.start! >= start && e.end! <= end)).map(e => e.key);
}

/**
 * One segmented page's conversation facts, incrementally (module doc). `gapMinutes` is the page's own
 * conversation_segment_gap_minutes (null: the default). Returns the end of the newest window it extracted.
 */
export async function processSegmentedConversationPage(run: SegmentedConversationRun, page: Page,
  opts: { gapMinutes: number | null; sinceIso?: string }): Promise<{ newestEnd: string | null }> {
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
  const intact = (i: number) => current.has(liveIds[i]!) && (rowOutput(priorRow.get(liveIds[i]!)).prev ?? null) === prevOf(i);
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
  const earlier: Array<{ key: string; start?: string; end?: string }> = [];
  for (const row of prior) {
    if ((position.get(row.occurrenceId) ?? Infinity) < from) continue;
    const same = row.version === CONVERSATION_FACTS_DERIVATION_VERSION && hex(row.contextHash) === hex(contextHash);
    for (const record of rowOutput(row).windows) {
      earlier.push({ key: keyOf(row.occurrenceId, record), start: record.start, end: record.end });
      if (same) reusable.set(record.sha, [...(reusable.get(record.sha) ?? []), { occurrenceId: row.occurrenceId, record }]);
    }
  }
  const windows: StreamWindow[] = [];
  const pendingMoves: Array<{ from: string; to: SourceWindow }> = [];
  const reused = new Set<string>();
  const startsGroup = new Map<number, boolean>();
  const ordinals = new Map<number, number>();
  const pageTitle = page.title || page.slug;
  const streamOpts = { page, gapMinutes: opts.gapMinutes, sinceIso: opts.sinceIso };
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
    await streamConversationWindows(occurrences, start, end, streamOpts, readText, {
      window(ownerIndex, seg) {
        const owner = liveIds[ownerIndex]!;
        const ordinal = ordinals.get(owner) ?? 0;
        ordinals.set(owner, ordinal + 1);
        const text = renderSegmentForExtraction(pageTitle, seg);
        const window = sourceWindowFor(owner, ordinal, text);
        const hit = reusable.get(window.window_text_sha)?.shift();
        if (!hit) { runWindows.push({ owner, seg, text, window, state: 'todo', facts: 0 }); return; }
        const was = keyOf(hit.occurrenceId, hit.record);
        reused.add(was);
        if (was !== sourceWindowKey(window)) pendingMoves.push({ from: was, to: window });
        runWindows.push({ owner, seg, text: null, window, state: 'reused', facts: hit.record.facts });
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
      const records = mine.filter(w => w.state !== 'todo')
        .map(w => ({ ordinal: w.window.window_ordinal, sha: w.window.window_text_sha, facts: w.facts, start: w.seg.startIso, end: w.seg.endIso }));
      const finished = records.length === mine.length;
      if (!finished && !records.length && occurrenceId !== stopOwner) return [];
      return [{ pageId: page.id, kind: KIND, occurrenceId, version: CONVERSATION_FACTS_DERIVATION_VERSION, segmentSha256: live[streamedFrom + k]!.sha256,
        contextHash, state: finished && !opts.sinceIso ? 'done' : 'partial', output: { windows: records, starts_group: startsGroup.get(occurrenceId) ?? false, prev: prevOf(streamedFrom + k) },
        receipt: finished ? null : { kind: 'unread_windows', pipeline: KIND, reason: stop ?? 'in_progress', windows_read: records.length, windows_total: mine.length } }];
    });
    const keep = settled ? [...liveIds.slice(0, from).flatMap(id => rowOutput(priorRow.get(id)).windows.map(w => keyOf(id, w))),
      ...windows.map(w => sourceWindowKey(w.window))] : null;
    const clear = settled ? [] : [...batch.keys, ...coveredKeys(windows, earlier.filter(e => !reused.has(e.key))).filter(key => !cleared.has(key))];
    const outcome = !settled ? null : keep!.length ? terminalAuditFact(page.slug, 0, versionToken)
      : nonExtractableAuditFact(page.slug, 0, versionToken, 'fewer than two eligible messages');
    const moves = pendingMoves.splice(0);
    const out = await writeDerivedFacts(engine, sourceId, page.slug, async db => {
      const published = await publishConversationFacts(db, sourceId, page.slug, outcome ? [...batch.rows, outcome] : batch.rows,
        { scope: 'window', segments: { windows: batch.windows, moves, keep, clear, retireUnanchored: settled } });
      if (derived.length) await db.upsertSegmentDerivations(derived);
      if (settled) await db.retireSegmentDerivations(page.id, liveIds, { kind: KIND });
      return published;
    });
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
        const metered = await meterPaidCall(engine, page, `facts:${model}`, estimateFactsExtractionUsd(model, text.length, maxTokens, pricingOverrides),
          () => extractConversationWindow(run, page, w.seg, text, 0, entityHints), { pricingOverrides });
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
