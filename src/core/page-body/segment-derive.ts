/**
 * Incremental derivation over a segmented page (Wave B spec 8.1, 8.2, PR 4 lane 4a): the shared driver the unpaid
 * pipelines (links, mentions, timeline, fences) use instead of a full pass over every block.
 *
 * The unit of work is a run: the live manifest rows of one region joined by forced cuts, which bodyBlocks reads
 * together (segment-blocks.ts), so every block a run yields starts where the parsers start fresh. A run's result is
 * stored on its first occurrence's page_segment_derivations row; its other occurrences get a row naming that first
 * occurrence. Each row's context hash covers the run's composition (every member's sha and entry state, its region and
 * whether it opens it), the page's withdrawal ledger and segmenter version, and the page-level inputs the pipeline
 * passes, so a run whose rows all match is current and the work left is found from manifest metadata alone.
 *
 * A run is read only when it is due (or a pipeline asks for a neighbour as context). The read checks that the body
 * generation and the ledger it planned from are still the page's; otherwise it throws SegmentDerivationRaced and the
 * caller falls back to its full pass, so a row never pairs one generation's metadata with another's text.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { canonicalJson } from '../belief/keys.ts';
import { planSegmentDerivations, segmentDerivationContextHash, type LiveSegment, type SegmentDerivationInput, type SegmentDerivationKind,
  type SegmentDerivationRow } from './derivations.ts';
import { bodyBlocks, type BodyBlock } from './segment-blocks.ts';
import { ledgerApplies, readBodyLedger } from './segment-ledger.ts';
import { SEGMENTER_VERSION } from './segmenter.ts';
import type { BodyRegion, ManifestRow } from './types.ts';

/** Bump a kind's version to re-derive every page's rows of that kind once. */
export const SEGMENT_PIPELINE_VERSIONS = { links: 1, mentions: 1, timeline: 1, fences: 1 } as const satisfies Partial<Record<SegmentDerivationKind, number>>;
export type UnpaidDerivationKind = keyof typeof SEGMENT_PIPELINE_VERSIONS;

/** @internal Runs derived (and their occurrences) and runs reused per kind, for the work-volume tests. Counts, not time. */
export const segmentDeriveWork: Record<UnpaidDerivationKind, { derived: number; occurrences: number; reused: number }> = {
  links: { derived: 0, occurrences: 0, reused: 0 }, mentions: { derived: 0, occurrences: 0, reused: 0 },
  timeline: { derived: 0, occurrences: 0, reused: 0 }, fences: { derived: 0, occurrences: 0, reused: 0 },
};

export interface DeriveRun {
  index: number;
  region: BodyRegion;
  /** The run opens its region. */
  first: boolean;
  seqs: number[];
  occurrences: number[];
  shas: Uint8Array[];
  entryStates: unknown[];
  bytes: number;
}

export interface DerivationScope {
  pageId: number;
  slug: string;
  sourceId: string;
  generation: number;
  runs: DeriveRun[];
  /** SHA-256 of the withdrawal ledger when one applies to the page (the overlay changes text), else null. */
  ledgerKey: string | null;
  stale: boolean;
}

export interface SegmentedDerivationPage { id: number; slug: string; source_id: string }

/** The page's body moved (another generation, another ledger) between the plan and the read. */
export class SegmentDerivationRaced extends Error {
  constructor(slug: string) {
    super(`Segmented page ${slug} changed while its derivations were read.`);
    this.name = 'SegmentDerivationRaced';
  }
}

const toJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) as unknown : v;
const bytesOf = (v: unknown) => v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(Buffer.from(String(v).replace(/^\\x/, ''), 'hex'));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function ledgerKey(engine: BrainEngine, page: SegmentedDerivationPage): Promise<string | null> {
  const ledger = await readBodyLedger(engine, page.source_id, page.slug);
  return ledgerApplies(ledger) ? createHash('sha256').update(canonicalJson(ledger)).digest('hex') : null;
}

/** The live runs of a segmented page from its manifest rows (no segment text), or null when it is not segmented. */
export async function derivationScope(engine: BrainEngine, page: SegmentedDerivationPage): Promise<DerivationScope | null> {
  const [state] = await engine.executeRaw<{ body_storage: string; body_generation: string; segmenter_version: number | null }>(
    'SELECT body_storage, body_generation::text AS body_generation, segmenter_version FROM pages WHERE id=$1', [page.id]);
  if (state?.body_storage !== 'segmented') return null;
  const generation = Number(state.body_generation);
  const rows = await engine.executeRaw<{ seq: number; occurrence_id: string; region: BodyRegion; sha256: unknown; entry_state: unknown; cut_kind: string; byte_len: number }>(
    `SELECT seq, occurrence_id::text AS occurrence_id, region, sha256, entry_state, cut_kind, byte_len FROM page_body_manifest
      WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) ORDER BY seq`, [page.id, generation]);
  const runs: DeriveRun[] = [];
  for (const region of ['truth', 'timeline'] as const) {
    const own = rows.filter(row => row.region === region);
    for (let i = 0; i < own.length;) {
      let j = i;
      while (j + 1 < own.length && own[j]!.cut_kind === 'forced') j++;
      const members = own.slice(i, j + 1);
      runs.push({ index: runs.length, region, first: i === 0, seqs: members.map(row => Number(row.seq)), occurrences: members.map(row => Number(row.occurrence_id)),
        shas: members.map(row => bytesOf(row.sha256)), entryStates: members.map(row => toJson(row.entry_state)), bytes: members.reduce((n, row) => n + Number(row.byte_len), 0) });
      i = j + 1;
    }
  }
  return { pageId: page.id, slug: page.slug, sourceId: page.source_id, generation, runs, ledgerKey: await ledgerKey(engine, page),
    stale: Number(state.segmenter_version) !== SEGMENTER_VERSION };
}

/** The identity of a run's stored text and of its place in its region. */
export function runIdentity(run: DeriveRun): unknown {
  return [run.region, run.first, run.shas.map(hex), run.entryStates];
}

/** Per member occurrence, the context hash of `run` for `kind` under the page-level `inputs`. */
export function runContextHashes(kind: UnpaidDerivationKind, scope: DerivationScope, run: DeriveRun, inputs: Record<string, unknown>): Uint8Array[] {
  const page = { ...inputs, run: runIdentity(run), ledger: scope.ledgerKey, stale: scope.stale };
  return run.entryStates.map((entryState, i) => segmentDerivationContextHash(kind, { entryState, page: { ...page, member: i } }));
}

export interface RunPlan<O> {
  /** Runs to derive, in page order. */
  todo: DeriveRun[];
  /** Outputs of the runs whose rows all match, by run index. */
  current: Map<number, O>;
}

/** Split a page's runs into due and current for `kind`, given each run's page-level inputs (`inputsOf`) and its rows (`read`, else read here). */
export async function planRuns<O>(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope,
  inputsOf: (run: DeriveRun) => Record<string, unknown>, read?: readonly SegmentDerivationRow[]): Promise<RunPlan<O>> {
  const result = splitRuns<O>(kind, scope, inputsOf, read ?? await engine.readSegmentDerivations(scope.pageId, { kind }));
  segmentDeriveWork[kind].reused += result.current.size;
  return result;
}

function splitRuns<O>(kind: UnpaidDerivationKind, scope: DerivationScope, inputsOf: (run: DeriveRun) => Record<string, unknown>,
  rows: readonly SegmentDerivationRow[]): RunPlan<O> {
  const live: LiveSegment[] = [];
  for (const run of scope.runs) {
    const hashes = runContextHashes(kind, scope, run, inputsOf(run));
    run.occurrences.forEach((occurrenceId, i) => live.push({ occurrenceId, sha256: run.shas[i]!, contextHash: hashes[i]! }));
  }
  const plan = planSegmentDerivations(kind, SEGMENT_PIPELINE_VERSIONS[kind], live, rows);
  const settled = new Map(plan.current.map(row => [row.occurrenceId, row]));
  const result: RunPlan<O> = { todo: [], current: new Map() };
  for (const run of scope.runs) {
    const first = settled.get(run.occurrences[0]!);
    if (first && run.occurrences.every(id => settled.has(id))) result.current.set(run.index, first.output as O);
    else result.todo.push(run);
  }
  return result;
}

/**
 * Read the blocks of the runs `wanted` names (a set of indices, or a predicate asked as each run is reached, in order),
 * in page order, handing each to `onBlock` with its run; the region separator between truth and timeline is handed
 * with run null. Runs not wanted are never read. Throws SegmentDerivationRaced when the page's generation or ledger
 * moved from the scope's.
 */
export async function readRuns(engine: BrainEngine, scope: DerivationScope, wanted: ReadonlySet<number> | ((run: DeriveRun) => boolean),
  onBlock: (run: DeriveRun | null, block: BodyBlock) => void | Promise<void>, opts: { separator?: string } = {}): Promise<void> {
  if (typeof wanted !== 'function' && !wanted.size) return;
  const wants = typeof wanted === 'function' ? wanted : (run: DeriveRun) => wanted.has(run.index);
  const bySeq = new Map(scope.runs.map(run => [run.seqs[0]!, run]));
  let current: DeriveRun | null = null;
  const page = { id: scope.pageId, slug: scope.slug, source_id: scope.sourceId };
  for await (const block of bodyBlocks(engine, page, {
    ...(opts.separator !== undefined ? { separator: opts.separator } : {}),
    want: ({ seqs }) => {
      const run = bySeq.get(seqs[0]!);
      if (!run || run.seqs.length !== seqs.length || run.seqs.some((seq, i) => seq !== seqs[i])) throw new SegmentDerivationRaced(scope.slug);
      current = wants(run) ? run : null;
      return current !== null;
    },
  })) await onBlock(block.region === null ? null : current, block);
  await assertScopeCurrent(engine, scope);
}

/** The page still has the scope's generation and ledger. */
export async function assertScopeCurrent(engine: BrainEngine, scope: DerivationScope): Promise<void> {
  const [state] = await engine.executeRaw<{ body_generation: string; body_storage: string }>(
    'SELECT body_generation::text AS body_generation, body_storage FROM pages WHERE id=$1', [scope.pageId]);
  if (state?.body_storage !== 'segmented' || Number(state.body_generation) !== scope.generation
    || await ledgerKey(engine, { id: scope.pageId, slug: scope.slug, source_id: scope.sourceId }) !== scope.ledgerKey) throw new SegmentDerivationRaced(scope.slug);
}

/**
 * Store the outputs of derived runs (`outputs` by run index, under the inputs `inputsOf` gives) and delete the rows of
 * occurrences no longer live. The first occurrence of a run holds its output; the others name it.
 */
export async function commitRuns(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope, outputs: ReadonlyMap<number, unknown>,
  inputsOf: (run: DeriveRun) => Record<string, unknown>): Promise<void> {
  await storeRuns(engine, kind, scope, outputs, inputsOf);
  await engine.retireSegmentDerivations(scope.pageId, scope.runs.flatMap(run => run.occurrences), { kind });
}

async function storeRuns(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope, outputs: ReadonlyMap<number, unknown>,
  inputsOf: (run: DeriveRun) => Record<string, unknown>): Promise<void> {
  const rows: SegmentDerivationInput[] = [];
  for (const [index, output] of outputs) {
    const run = scope.runs[index]!;
    const hashes = runContextHashes(kind, scope, run, inputsOf(run));
    segmentDeriveWork[kind].derived++;
    segmentDeriveWork[kind].occurrences += run.occurrences.length;
    run.occurrences.forEach((occurrenceId, i) => rows.push({ pageId: scope.pageId, kind, occurrenceId, version: SEGMENT_PIPELINE_VERSIONS[kind],
      segmentSha256: run.shas[i]!, contextHash: hashes[i]!, state: 'done', output: i === 0 ? output : { run: run.occurrences[0] }, receipt: null }));
  }
  if (rows.length) await engine.upsertSegmentDerivations(rows);
}

/** Runs per batch of streamRuns: rows and texts of at most this many runs are held at once. */
const STREAM_BATCH_RUNS = 2;

/** How streamRuns derives one due run: `start` makes its empty output, `block` folds each of its blocks in. */
export interface RunDeriver<O> {
  start(run: DeriveRun): O;
  block(output: O, block: BodyBlock): void;
}

/**
 * planRuns, deriving and visiting for a kind whose outputs are large (one entry per timeline line), holding the rows of
 * at most STREAM_BATCH_RUNS runs and one due run's output at a time. The rows are read in batches to find the due runs;
 * then one read of the body (readRuns) derives each due run in page order, stores it and hands it to `visit`, and the
 * current runs before it are handed over from their rows, read again in batches. Every block read also goes to
 * `onBlock`. A current run whose rows changed in between throws SegmentDerivationRaced. Rows of occurrences no longer
 * live are deleted at the end.
 */
export async function streamRuns<O>(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope,
  inputsOf: (run: DeriveRun) => Record<string, unknown>, deriver: RunDeriver<O>, visit: (run: DeriveRun, output: O) => void,
  onBlock?: (run: DeriveRun | null, block: BodyBlock) => void): Promise<void> {
  const batchRows = (runs: readonly DeriveRun[]) => engine.readSegmentDerivations(scope.pageId, { kind, occurrenceIds: runs.flatMap(run => run.occurrences) });
  const due = new Set<number>();
  for (let at = 0; at < scope.runs.length; at += STREAM_BATCH_RUNS) {
    const batch = scope.runs.slice(at, at + STREAM_BATCH_RUNS);
    for (const run of (await planRuns<O>(engine, kind, { ...scope, runs: batch }, inputsOf, await batchRows(batch))).todo) due.add(run.index);
  }
  let next = 0;
  const handOver = async (until: number) => {
    while (next < until) {
      const batch = scope.runs.slice(next, Math.min(until, next + STREAM_BATCH_RUNS)).filter(run => !due.has(run.index));
      const plan = splitRuns<O>(kind, { ...scope, runs: batch }, inputsOf, await batchRows(batch));
      if (plan.todo.length) throw new SegmentDerivationRaced(scope.slug);
      for (const run of batch) visit(run, plan.current.get(run.index)!);
      next = Math.min(until, next + STREAM_BATCH_RUNS);
    }
  };
  let deriving: { run: DeriveRun; output: O } | null = null;
  const finish = async () => {
    if (!deriving) return;
    const { run, output } = deriving;
    deriving = null;
    await storeRuns(engine, kind, scope, new Map([[run.index, output]]), inputsOf);
    visit(run, output);
    next = run.index + 1;
  };
  const begin = async (run: DeriveRun, block: BodyBlock) => {
    await finish();
    await handOver(run.index);
    deriving = { run, output: deriver.start(run) };
    deriver.block(deriving.output, block);
  };
  await readRuns(engine, scope, due, (run, block) => {
    onBlock?.(run, block);
    if (!run) return;
    if (deriving?.run !== run) return begin(run, block);
    deriver.block(deriving.output, block);
  });
  await finish();
  await handOver(scope.runs.length);
  await engine.retireSegmentDerivations(scope.pageId, scope.runs.flatMap(run => run.occurrences), { kind });
}

/** Bytes of neighbouring runs whose link rows a rewrite also drops: a link excerpt reaches 120 units past its block. */
const LINK_REACH_BYTES = 4096;

/**
 * Delete the derivation rows that may hold text a fence rewrite (forget, purge; spec 11) replaced, in the caller's
 * transaction: every kind's rows of each run holding a rewritten row (a run's output sits on its first occurrence),
 * and the links rows of the runs on either side up to LINK_REACH_BYTES away, whose candidate excerpts can reach into
 * it. `rows` is the generation's manifest in order; `spans` the rewritten index ranges. Returns the rows deleted.
 */
export async function deleteRewrittenDerivations(engine: BrainEngine, pageId: number,
  rows: ReadonlyArray<Pick<ManifestRow, 'occurrenceId' | 'region' | 'cutKind' | 'byteLen'>>, spans: ReadonlyArray<{ from: number; to: number }>): Promise<number> {
  const joined = (i: number) => i + 1 < rows.length && rows[i]!.cutKind === 'forced' && rows[i]!.region === rows[i + 1]!.region;
  const runOf = (i: number): [number, number] => {
    let from = i, to = i;
    while (from > 0 && joined(from - 1)) from--;
    while (joined(to)) to++;
    return [from, to];
  };
  const touched = new Set<number>(), reach = new Set<number>();
  const add = (into: Set<number>, from: number, to: number) => { for (let i = from; i <= to; i++) into.add(rows[i]!.occurrenceId); };
  for (const span of spans) {
    const [from] = runOf(span.from), [, to] = runOf(span.to);
    add(touched, from, to);
    for (let at = from - 1, bytes = 0; at >= 0 && bytes < LINK_REACH_BYTES;) {
      const [a, b] = runOf(at);
      add(reach, a, b);
      for (let i = a; i <= b; i++) bytes += rows[i]!.byteLen;
      at = a - 1;
    }
    for (let at = to + 1, bytes = 0; at < rows.length && bytes < LINK_REACH_BYTES;) {
      const [a, b] = runOf(at);
      add(reach, a, b);
      for (let i = a; i <= b; i++) bytes += rows[i]!.byteLen;
      at = b + 1;
    }
  }
  if (!touched.size) return 0;
  return (await engine.executeRaw(`DELETE FROM page_segment_derivations WHERE page_id=$1
    AND (occurrence_id = ANY($2::bigint[]) OR (pipeline = 'links' AND occurrence_id = ANY($3::bigint[]))) RETURNING 1`, [pageId, [...touched], [...reach]])).length;
}

/** SHA-256 hex (its first 32 digits) of a key, recorded in an output instead of the key's text. */
export function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}
