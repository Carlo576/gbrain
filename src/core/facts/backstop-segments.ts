/**
 * The facts backstop over a segmented page (wave-b spec 8.2 "Facts backstop", 8.3; PR 4 lane 4b): new occurrences
 * only, in MAX_TURN_TEXT_CHARS windows cut at line starts, newest first, each window reserved against the page's
 * spend cap (reservePageSpend, facts:<model>) before its extraction.
 *
 * Per occurrence a page_segment_derivations row (kind facts_backstop) records the segment sha, a context hash (region,
 * model, window cap, observation date) and the windows extracted (ordinal, text sha, facts inserted). A window an
 * earlier run extracted under the same context is never extracted again: in the same occurrence (a partial run), or
 * verbatim in a retired one (a rewritten tail keeps its earlier windows), so an append pays for its new text plus the
 * one window it grew. Replaces planSegmentedExtraction's whole-body pass and its watermark for segmented pages; the
 * page_extraction_state receipt is cleared, a stopped occurrence's receipt lives on its row.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { estimateChatCallUsd, reservePageSpend, spendGrant } from '../page-embedding-budget.ts';
import { setExtractionReceipt } from '../extraction-watermark.ts';
import { planSegmentDerivations, segmentDerivationContextHash, type SegmentDerivationInput, type SegmentDerivationRow } from '../page-body/derivations.ts';
import { readConversationOccurrences, readOccurrenceText } from '../page-body/segment-conversation.ts';
import { MAX_TURN_TEXT_CHARS, getFactsExtractionMaxTokens } from './extract.ts';

const KIND = 'facts_backstop';
/** Bump when the windowing or the row output changes shape: every occurrence is extracted again once. */
export const FACTS_BACKSTOP_DERIVATION_VERSION = 1;

interface WindowRecord { ordinal: number; sha: string; facts: number }

const records = (row: SegmentDerivationRow | undefined): WindowRecord[] => {
  const windows = (row?.output as { windows?: unknown } | null)?.windows;
  return Array.isArray(windows) ? windows as WindowRecord[] : [];
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Consecutive windows of at most \`cap\` characters covering \`text\`, cut after a newline when one falls in the window, never inside a surrogate pair. */
export function lineWindows(text: string, cap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + cap);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start) end = newline + 1;
      else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

export interface SegmentedBackstopRun<R extends { inserted: number; skipped_reason?: unknown }> {
  engine: BrainEngine;
  page: { id: number; body_storage: 'segmented'; body_bytes?: number | null };
  model: string;
  /** Observation date the extractor is told (part of the context: a change re-extracts). */
  observation: string | null;
  signal?: AbortSignal;
  /** One window through the backstop pipeline. A result with \`skipped_reason\` stops the run; that window stays unextracted. */
  extract(text: string): Promise<R>;
}

/**
 * The backstop's windows of every new or changed occurrence of a segmented page, newest first, until the cap refuses
 * or a window is skipped. Returns each window's pipeline result, in call order, and why the run stopped (null: done).
 */
export async function runSegmentedBackstop<R extends { inserted: number; skipped_reason?: unknown }>(run: SegmentedBackstopRun<R>):
  Promise<{ results: R[]; stop: 'cap_reached' | 'skipped' | null }> {
  const { engine, page } = run;
  const { body, occurrences } = await readConversationOccurrences(engine, page.id);
  const context = { model: run.model, cap: MAX_TURN_TEXT_CHARS, observation: run.observation };
  const live = occurrences.map(o => ({ occurrenceId: o.row.occurrenceId, sha256: o.row.sha256,
    contextHash: segmentDerivationContextHash(KIND, { entryState: { region: o.row.region }, page: context }) }));
  const prior = await engine.readSegmentDerivations(page.id, { kind: KIND });
  const plan = planSegmentDerivations(KIND, FACTS_BACKSTOP_DERIVATION_VERSION, live, prior);
  const priorRow = new Map(prior.map(row => [row.occurrenceId, row]));
  const extracted = new Set<string>();
  for (const row of [...plan.retired, ...prior]) {
    if (row.version === FACTS_BACKSTOP_DERIVATION_VERSION) for (const w of records(row)) extracted.add(`${hex(row.contextHash)}:${w.sha}`);
  }
  const maxTokens = await getFactsExtractionMaxTokens(engine);
  const results: R[] = [];
  const derived: SegmentDerivationInput[] = [];
  let stop: 'cap_reached' | 'skipped' | null = null;
  const todo = new Map(plan.todo.map(segment => [segment.occurrenceId, segment]));
  for (const occurrence of [...occurrences].reverse()) {
    const segment = todo.get(occurrence.row.occurrenceId);
    if (!segment || stop) continue;
    const old = priorRow.get(segment.occurrenceId);
    const done = new Map((old && old.version === FACTS_BACKSTOP_DERIVATION_VERSION && hex(old.contextHash) === hex(segment.contextHash) ? records(old) : [])
      .map(w => [w.ordinal, w]));
    const windows = lineWindows(await readOccurrenceText(engine, body, occurrence.row), MAX_TURN_TEXT_CHARS);
    for (let ordinal = windows.length - 1; ordinal >= 0; ordinal--) {
      const text = windows[ordinal]!;
      const key = sha(text);
      if (done.get(ordinal)?.sha === key) continue;
      if (extracted.has(`${hex(segment.contextHash)}:${key}`) || !text.trim()) { done.set(ordinal, { ordinal, sha: key, facts: 0 }); continue; }
      if (run.signal?.aborted) { stop = 'skipped'; break; }
      const decision = await reservePageSpend(engine, page, `facts:${run.model}`, estimateChatCallUsd(run.model, text.length, maxTokens));
      if (decision.kind === 'refused') { stop = 'cap_reached'; break; }
      const result = await spendGrant(decision.kind === 'grant' ? decision.grant : undefined, () => run.extract(text));
      results.push(result);
      if (result.skipped_reason) { stop = 'skipped'; break; }
      done.set(ordinal, { ordinal, sha: key, facts: result.inserted });
      extracted.add(`${hex(segment.contextHash)}:${key}`);
    }
    const kept = windows.flatMap((text, ordinal) => done.get(ordinal)?.sha === sha(text) ? [done.get(ordinal)!] : []);
    const finished = kept.length === windows.length;
    derived.push({ pageId: page.id, kind: KIND, occurrenceId: segment.occurrenceId, version: FACTS_BACKSTOP_DERIVATION_VERSION,
      segmentSha256: segment.sha256, contextHash: segment.contextHash, state: finished ? 'done' : 'partial', output: { windows: kept },
      receipt: finished ? null : { kind: 'unread_windows', pipeline: KIND, reason: stop, windows_read: kept.length, windows_total: windows.length } });
  }
  if (derived.length) await engine.upsertSegmentDerivations(derived);
  await engine.retireSegmentDerivations(page.id, live.map(segment => segment.occurrenceId), { kind: KIND });
  await setExtractionReceipt(engine, page.id, KIND, null);
  return { results, stop };
}
