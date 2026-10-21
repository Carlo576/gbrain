/**
 * extract_atoms over a segmented page (wave-b spec 8.2 "extract_atoms", 8.3; PR 4 lane 4b). Discovery finds a
 * segmented page with no complete scan state for its content hash; expandSegmentedAtomPages turns it into work items
 * that are <= input-cap windows of its new or changed occurrences, cut at line starts, newest first. The phase loop
 * extracts each window like a page item and, instead of the page completion stamp, settles the window on the
 * occurrence's page_segment_derivations row (kind extract_atoms: segment sha, context hash, each window's text sha and
 * the atom slugs it produced). An append offers only the new text's windows; a window whose text an earlier run
 * extracted under the same context is never offered again, so a rewritten tail keeps its earlier windows' atoms.
 *
 * Each window's call is metered against the page's atoms cap (meterPaidCall, atoms:<model>: reserved first, the
 * provider-reported cost booked); a refusal skips the page's remaining windows and records an unread_windows receipt on
 * each unfinished occurrence's row. When every live occurrence is settled, the page's scan state is stamped complete
 * for its content hash (the revision check) and then, in the same transaction, atoms of windows that left the page (and
 * atoms of an earlier whole-page extraction) are retired, so a page that changed meanwhile retires nothing.
 * The completion CAS stays on content_hash + knowledge_revision (completeAtomReceipts). Managed brains do not extract
 * segmented pages (their publication path is whole-page).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { estimateChatCallUsd, meterPaidCall, unpricedModelReceipt } from '../page-embedding-budget.ts';
import { planSegmentDerivations, segmentDerivationContextHash, type SegmentDerivationInput, type SegmentDerivationRow } from '../page-body/derivations.ts';
import { readConversationOccurrences, readOccurrenceText } from '../page-body/segment-conversation.ts';
import { lineWindows } from '../facts/backstop-segments.ts';
import { retireStaleAtomsIn, writeAtomPageState, type AtomPageInput, type AtomPageWindow } from './extract-atoms-page-state.ts';

const KIND = 'extract_atoms';
/** Bump when the windowing or the row output changes shape: every occurrence is extracted again once. */
export const EXTRACT_ATOMS_DERIVATION_VERSION = 1;
/** Windows one run offers per page; the rest wait for the next run (the page is not stamped complete). */
export const MAX_ATOM_WINDOWS_PER_PAGE_RUN = 16;

interface WindowRecord { ordinal: number; sha: string; atoms: string[] }
interface OccurrenceState { occurrenceId: number; sha256: Uint8Array; contextHash: Uint8Array; total: number; done: Map<number, WindowRecord> }

const records = (row: SegmentDerivationRow | undefined): WindowRecord[] => {
  const windows = (row?.output as { windows?: unknown } | null)?.windows;
  return Array.isArray(windows) ? windows as WindowRecord[] : [];
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Segmented pages become their windows; other pages pass through. Returns the atoms retired by pages that settled with nothing left to extract. */
export async function expandSegmentedAtomPages(engine: BrainEngine, sourceId: string, pages: readonly AtomPageInput[],
  opts: { managed: boolean; cap: number; dryRun: boolean }): Promise<{ pages: AtomPageInput[]; retired: string[] }> {
  const out: AtomPageInput[] = [];
  const retired: string[] = [];
  for (const page of pages) {
    if (!page.segmented) { out.push(page); continue; }
    if (opts.managed || !page.identity) continue;
    const windows = await planPage(engine, sourceId, page, opts);
    if (windows.items.length) out.push(...windows.items);
    else if (windows.settled && !opts.dryRun) retired.push(...await windows.settle());
  }
  return { pages: out, retired };
}

async function planPage(engine: BrainEngine, sourceId: string, page: AtomPageInput, opts: { cap: number; dryRun: boolean }) {
  const pageId = page.identity!.pageId;
  const { body, occurrences } = await readConversationOccurrences(engine, pageId);
  const live = occurrences.map(o => ({ occurrenceId: o.row.occurrenceId, sha256: o.row.sha256,
    contextHash: segmentDerivationContextHash(KIND, { entryState: { region: o.row.region }, page: { cap: opts.cap } }) }));
  const prior = await engine.readSegmentDerivations(pageId, { kind: KIND });
  const plan = planSegmentDerivations(KIND, EXTRACT_ATOMS_DERIVATION_VERSION, live, prior);
  const priorRow = new Map(prior.map(row => [row.occurrenceId, row]));
  const extracted = new Map<string, string[]>();
  for (const row of [...plan.retired, ...prior]) {
    if (row.version === EXTRACT_ATOMS_DERIVATION_VERSION) for (const w of records(row)) extracted.set(`${hex(row.contextHash)}:${w.sha}`, w.atoms ?? []);
  }
  const states = new Map<number, OccurrenceState>();
  const items: AtomPageInput[] = [];
  let unread = false;
  let stop: 'cap_reached' | 'purge_sweep_pending' | null = null;
  let unpricedModel: string | null = null;
  let open = 0;
  const todo = new Map(plan.todo.map(segment => [segment.occurrenceId, segment]));
  const row = (state: OccurrenceState): SegmentDerivationInput => {
    const finished = state.done.size === state.total;
    return { pageId, kind: KIND, occurrenceId: state.occurrenceId, version: EXTRACT_ATOMS_DERIVATION_VERSION, segmentSha256: state.sha256,
      contextHash: state.contextHash, state: finished ? 'done' : 'partial', output: { windows: [...state.done.values()].sort((a, b) => a.ordinal - b.ordinal) },
      receipt: unpricedModelReceipt(KIND, unpricedModel, stop, finished || !stop ? null : { windows_read: state.done.size, windows_total: state.total }) };
  };
  const settlePage = async (): Promise<string[]> => {
    const keep = new Set<string>();
    for (const current of plan.current) for (const w of records(current)) for (const slug of w.atoms ?? []) keep.add(slug);
    for (const state of states.values()) for (const w of state.done.values()) for (const slug of w.atoms) keep.add(slug);
    // PR 4 (Wave B incremental derivation, transcripts): the revision check, then the retire, in one transaction.
    return maintenanceTransaction(engine, async tx => {
      await writeAtomPageState(tx, sourceId, page, 'complete');
      return retireStaleAtomsIn(tx, sourceId, { key: 'source_slug', value: page.slug }, '', [...keep]);
    });
  };
  for (const occurrence of [...occurrences].reverse()) {
    const segment = todo.get(occurrence.row.occurrenceId);
    if (!segment) continue;
    if (items.length >= MAX_ATOM_WINDOWS_PER_PAGE_RUN) { unread = true; break; }
    const old = priorRow.get(segment.occurrenceId);
    const same = old && old.version === EXTRACT_ATOMS_DERIVATION_VERSION && hex(old.contextHash) === hex(segment.contextHash);
    const texts = lineWindows(await readOccurrenceText(engine, body, occurrence.row), opts.cap);
    const state: OccurrenceState = { occurrenceId: segment.occurrenceId, sha256: segment.sha256, contextHash: segment.contextHash, total: texts.length,
      done: new Map((same ? records(old) : []).map(w => [w.ordinal, { ...w, atoms: w.atoms ?? [] }])) };
    states.set(segment.occurrenceId, state);
    for (let ordinal = texts.length - 1; ordinal >= 0; ordinal--) {
      const text = texts[ordinal]!;
      const key = sha(text);
      if (state.done.get(ordinal)?.sha === key) continue;
      state.done.delete(ordinal);
      const reused = extracted.get(`${hex(segment.contextHash)}:${key}`);
      if (reused || !text.trim()) { state.done.set(ordinal, { ordinal, sha: key, atoms: reused ?? [] }); continue; }
      if (items.length >= MAX_ATOM_WINDOWS_PER_PAGE_RUN) { unread = true; continue; }
      open++;
      const window: AtomPageWindow = {
        async run(model, maxOutputTokens, call) {
          if (opts.dryRun) return { value: await call() };
          if (stop) return null;
          const pricingOverrides = await loadPricingOverrides(engine);
          const metered = await meterPaidCall(engine, { id: pageId, body_storage: 'segmented' }, `atoms:${model}`,
            estimateChatCallUsd(model, text.length, maxOutputTokens, pricingOverrides), call, { pricingOverrides });
          unpricedModel = metered.unpricedModel ?? unpricedModel;
          if (!('refused' in metered)) return metered;
          stop = metered.refused.reason === 'purge_sweep_pending' ? 'purge_sweep_pending' : 'cap_reached';
          const unfinished = [...states.values()].filter(s => s.done.size < s.total);
          if (unfinished.length) await engine.upsertSegmentDerivations(unfinished.map(row));
          return null;
        },
        async settle(atomSlugs) {
          state.done.set(ordinal, { ordinal, sha: key, atoms: atomSlugs });
          await engine.upsertSegmentDerivations([row(state)]);
          open--;
          return open === 0 && !unread && !stop ? settlePage() : [];
        },
      };
      items.push({ ...page, segmented: false, content: text, window });
    }
  }
  if (!opts.dryRun) {
    if (states.size) await engine.upsertSegmentDerivations([...states.values()].map(row));
    await engine.retireSegmentDerivations(pageId, live.map(segment => segment.occurrenceId), { kind: KIND });
  }
  return { items, settled: !unread && open === 0, settle: settlePage };
}
