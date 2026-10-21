/**
 * extraction_input_truncated (large pages A7): pages whose last extraction
 * read only part of its input, from the durable `input_truncated` receipts in
 * `page_extraction_state` (src/core/extraction-watermark.ts). Facts read the
 * first 8,000 characters when no watermark matched (or the newest 8,000 of a
 * long append); atoms read the first `cycle.extract_atoms.max_input_chars`;
 * conversation facts skip an input over the size cap. Appends after a
 * watermark are read incrementally, so the receipt marks text that was never
 * read. Warn when a receipt has a remedy (the atoms cap, an oversized
 * conversation input); facts-only receipts are reported as info. Reads the
 * database only.
 *
 * PR 4 (Wave B incremental derivation, transcripts): a segmented page's paid
 * derivations keep their receipt per occurrence on page_segment_derivations
 * (`unread_windows`: the run stopped before every window was read, at the
 * per-page spend cap or a window limit; the next run resumes there). Both tables
 * are read; a page counts once per pipeline and receipt kind.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { EXTRACT_MAX_INPUT_CHARS_KEY } from '../../../core/cycle/extract-atoms-input.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../../core/page-spend.ts';

interface ReceiptGroup { pipeline: string; kind: string; pages: number; samples: string[] }

const REMEDY: Record<string, string> = {
  facts_backstop: 'later appends are extracted from the appended text; for a conversation page, gbrain extract-conversation-facts --slug <slug> reads every window of the body',
  extract_atoms: `raise the cap so the next cycle reads more of each page: gbrain config set ${EXTRACT_MAX_INPUT_CHARS_KEY} <n>`,
  conversation_facts: 'the parser input (page body or raw_transcript sidecar) is over the conversation body cap and was not read; trim the sidecar under the cap or remove raw_transcript from the page frontmatter, then gbrain extract-conversation-facts --slug <slug>',
};

const UNREAD_WINDOWS = 'unread_windows';
const UNREAD_REMEDY = `the run stopped before every window of the page was read (the receipt's reason: the per-page spend cap, a window limit or a skipped window); the next run resumes where it stopped, and when the cap stopped it: gbrain config set ${PAGE_DERIVATION_CAP_KEY} <usd>`;
const remedy = (g: ReceiptGroup): string | null => g.kind === UNREAD_WINDOWS ? UNREAD_REMEDY : REMEDY[g.pipeline] ?? null;

const describe = (g: ReceiptGroup): string =>
  `${g.pipeline}/${g.kind}: ${g.pages} page(s) (e.g. ${g.samples.join(', ')}); ${remedy(g) ?? 'see the receipt in page_extraction_state'}`;

async function runExtractionInputTruncatedCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const rows = await connectedEngine(ctx).executeRaw<{ pipeline: string; kind: string; pages: number; samples: string[] }>(
      `WITH receipts AS (
         SELECT s.page_id, s.pipeline, COALESCE(s.input_truncated->>'kind', 'unknown') AS kind, s.updated_at
           FROM page_extraction_state s WHERE s.input_truncated IS NOT NULL
         UNION ALL
         SELECT d.page_id, d.pipeline, COALESCE(d.receipt->>'kind', 'unknown') AS kind, max(d.updated_at) AS updated_at
           FROM page_segment_derivations d WHERE d.receipt IS NOT NULL GROUP BY 1, 2, 3)
       SELECT r.pipeline, r.kind, count(DISTINCT r.page_id)::int AS pages,
              (array_agg(p.source_id || ':' || p.slug ORDER BY r.updated_at DESC))[1:3] AS samples
         FROM receipts r JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY 1, 2`);
    const groups: ReceiptGroup[] = rows.map(r => ({ pipeline: r.pipeline, kind: r.kind, pages: Number(r.pages), samples: r.samples ?? [] }));
    const details = { groups: groups.map(g => ({ ...g, remedy: remedy(g) })) };
    if (!groups.length) {
      checks.push({ name: 'extraction_input_truncated', status: 'ok', message: 'Every page extraction read all of its input (no head-only, tail-window or size-skip receipts).', details });
      return checks;
    }
    const summary = `Page extractions that read only part of their input: ${groups.map(describe).join('. ')}.`;
    const actionable = groups.filter(g => g.pipeline !== 'facts_backstop' || g.kind === UNREAD_WINDOWS);
    if (!actionable.length) {
      checks.push({ name: 'extraction_input_truncated', status: 'ok', severity: 'info', readiness_state: 'degraded', message: summary, details });
      return checks;
    }
    const atoms = actionable.find(g => g.pipeline === 'extract_atoms' && g.kind !== UNREAD_WINDOWS);
    const capped = actionable.some(g => g.kind === UNREAD_WINDOWS);
    checks.push({ name: 'extraction_input_truncated', status: 'warn', message: summary, details,
      ...(atoms
        ? { fix: agentFix(['gbrain', 'config', 'set', EXTRACT_MAX_INPUT_CHARS_KEY, '<n>'],
          'A higher cap lets the next extract_atoms cycle read more of each cut page; it raises model spend, so the value is the user\'s call.', 'extraction_input_truncated',
          { ask_user: true, consent: ['paid'], inputs: [{ name: 'n', how: 'a character count above the cut pages\' sizes, chosen with the user' }] }) }
        : capped
          ? { fix: agentFix(['gbrain', 'config', 'set', PAGE_DERIVATION_CAP_KEY, '<usd>'],
            'A higher per-page cap lets the next run read the windows the cap stopped; it raises model spend, so the value is the user\'s call.', 'extraction_input_truncated',
            { ask_user: true, consent: ['paid'], inputs: [{ name: 'usd', how: 'a per-page dollar cap chosen with the user' }] }) }
          : { fix_unavailable_reason: 'operator_judgement' as const }) });
  } catch (error) {
    checks.push(checkError('extraction_input_truncated', 'read the extraction receipts', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const extractionInputTruncatedEntry: DoctorEntry = { name: 'extraction_input_truncated', emits: ['extraction_input_truncated'], run: runExtractionInputTruncatedCheck };
