/**
 * #7846: extract_atoms writes a captured session's atoms only to the source
 * #6268 froze for it, never to the source the cycle runs for.
 *
 * Every session-corpus file resolves through `resolveCorpusFileSource`, the
 * resolver the facts sweep and dream synthesis use: a spool file's stamp, or
 * its session's frozen record (an unresolved record with a cwd is frozen first
 * from the brain's resolution chain, as the sweep does), and a top-level legacy
 * file only with durable evidence of its source. A file of the cycle's source
 * is extracted; a file of another source is skipped (`corpus_source_other`)
 * and extracts when the phase runs for that source; a file with no evidence of
 * its source is held with the resolver's reason until
 * `gbrain sweep --assign-corpus <source>` maps its session. Nothing falls back
 * to the cycle's source. Files outside the session corpus (the meeting
 * transcripts dir) are not session captures and pass unchanged.
 */
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { corpusSpoolDir } from '../context/corpus-segments.ts';
import { resolveCorpusFileSource, type CorpusSourceHold } from '../context/corpus-source.ts';

export interface AtomSourceRouting {
  /** Corpus files of other sources, counted by the source each belongs to. */
  corpus_source_other: Record<string, number>;
  /** Corpus files with no usable evidence of their source, counted by the resolver's hold reason. */
  held: Record<string, number>;
}

export const emptyAtomSourceRouting = (): AtomSourceRouting => ({ corpus_source_other: {}, held: {} });

/** The holds an operator mapping releases: the session never recorded a source. */
const MAPPABLE_HOLDS: ReadonlySet<CorpusSourceHold> = new Set(['corpus_source_unresolved', 'corpus_legacy_unstamped']);

function corpusLocation(filePath: string, corpusDir: string): 'spool' | 'legacy' | null {
  const root = resolve(corpusDir);
  const file = resolve(filePath);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return dirname(file) === resolve(corpusSpoolDir(root)) ? 'spool' : 'legacy';
}

/** The transcripts this run may extract into `sourceId`; every other corpus file is counted in `routing`. */
export async function keepAtomSourceTranscripts<T extends { filePath: string }>(engine: BrainEngine, transcripts: T[],
  opts: { corpusDir: string; sourceId: string }, routing: AtomSourceRouting): Promise<T[]> {
  const kept: T[] = [];
  for (const t of transcripts) {
    const location = corpusLocation(t.filePath, opts.corpusDir);
    if (!location) { kept.push(t); continue; }
    const owner = await resolveCorpusFileSource(engine, opts.corpusDir, basename(t.filePath), location);
    if (!owner.ok) routing.held[owner.reason] = (routing.held[owner.reason] ?? 0) + 1;
    else if (owner.sourceId !== opts.sourceId) routing.corpus_source_other[owner.sourceId] = (routing.corpus_source_other[owner.sourceId] ?? 0) + 1;
    else kept.push(t);
  }
  return kept;
}

/** Names every corpus file the phase left out, with the command that extracts or releases it. */
export function withAtomSourceRouting(result: PhaseResult, routing: AtomSourceRouting, sourceId: string): PhaseResult {
  const others = Object.entries(routing.corpus_source_other).sort(([a], [b]) => a.localeCompare(b));
  const held = Object.entries(routing.held).sort(([a], [b]) => a.localeCompare(b));
  if (!others.length && !held.length) return result;
  const otherCount = others.reduce((n, [, c]) => n + c, 0);
  const heldCount = held.reduce((n, [, c]) => n + c, 0);
  const fix = [
    ...others.map(([id]) => `gbrain dream --source ${id} --phase extract_atoms`),
    ...(held.some(([r]) => MAPPABLE_HOLDS.has(r as CorpusSourceHold)) ? ['gbrain sweep --assign-corpus <source>'] : []),
  ];
  const parts = [
    ...(otherCount ? [`${otherCount} corpus file(s) belong to other sources (${others.map(([id, c]) => `${id}: ${c}`).join(', ')}) and extract only under their own source`] : []),
    ...(heldCount ? [`${heldCount} held with no usable session source (${held.map(([r, c]) => `${r}: ${c}`).join(', ')})`] : []),
  ];
  process.stderr.write(`[extract_atoms] source ${sourceId}: ${parts.join('; ')}.${fix.length ? ` Fix: ${fix.join(' | ')}` : ''}\n`);
  return { ...result, summary: `${result.summary}; ${parts.join('; ')}`,
    details: { ...result.details, source_routing: { source_id: sourceId, ...routing, fix } } };
}
