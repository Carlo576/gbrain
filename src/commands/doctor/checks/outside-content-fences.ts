/**
 * GBRA-221 `outside_content_fences`: live facts, takes and links fence rows on pages whose body is text a third party
 * wrote (Gmail threads and calendar events from a Google source, GitHub issues, PRs and repo cards, imported chat
 * transcripts). Before GBRA-221 those renderers copied a sender's `<!--- gbrain:facts:begin -->` table into the page
 * verbatim, extract_facts promoted its rows (visibility and confidence as the sender wrote them), and a later re-render
 * carries a stored fence forward as if gbrain had written it. Renders now neutralize the markers, so a fence still on
 * such a page was planted before the fix or added by a gbrain writer (`remember`, loop extraction) on purpose; the
 * check cannot tell which, so it lists each page for review and removes nothing. Contact pages are out of scope: their
 * single-line fields cannot hold a fence. Location and counts only, never a cell value. Reads the database only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError, doctorVerify, withSkippedSegmented } from '../check-fix.ts';
import { parseFactsFence } from '../../../core/facts-fence.ts';
import { parseTakesFence } from '../../../core/takes-fence.ts';
import { parseLinksFence } from '../../../core/links-fence.ts';

const NAME = 'outside_content_fences';
const MARKER_SQL = 'gbrain:(facts|takes|links):begin';

interface Row { source_id: string; slug: string; type: string; compiled_truth: string | null; timeline: string | null; segmented: boolean }

async function runOutsideContentFences(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const rows = await connectedEngine(ctx).executeRaw<Row>(
      `SELECT p.source_id, p.slug, p.type, p.compiled_truth, p.timeline, p.body_storage = 'segmented' AS segmented
         FROM pages p JOIN sources s ON s.id = p.source_id
        WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE
          AND ((s.config->>'kind' = 'google' AND p.type IN ('email', 'meeting')) OR s.config->>'kind' = 'github'
               OR p.frontmatter ? 'transcript_import')
          AND (p.body_storage = 'segmented' OR p.compiled_truth ~ $1 OR p.timeline ~ $1)
        ORDER BY p.source_id, p.slug`, [MARKER_SQL]);
    const segmented = rows.filter(row => row.segmented).length;
    const items = rows.filter(row => !row.segmented).map(row => {
      const body = `${row.compiled_truth ?? ''}\n${row.timeline ?? ''}`;
      return { source_id: row.source_id, slug: row.slug, type: row.type, facts: parseFactsFence(body).facts.length,
        takes: parseTakesFence(body).takes.length, links: parseLinksFence(body).rows.length };
    }).filter(item => item.facts + item.takes + item.links > 0);
    const details = { pages: items.length, items, docs: 'docs/guides/troubleshooting.md#outside-content-fences' };
    if (!items.length) {
      checks.push(withSkippedSegmented({ name: NAME, status: 'ok', details,
        message: 'No imported email, calendar, GitHub or transcript page holds a live facts, takes or links fence row.' }, segmented));
      return checks;
    }
    const first = items[0]!;
    const list = items.slice(0, 5).map(item => `${item.source_id}:${item.slug} (facts ${item.facts}, takes ${item.takes}, links ${item.links})`).join('; ');
    checks.push(withSkippedSegmented({ name: NAME, status: 'warn', details,
      message: `${items.length} imported page(s) whose body is outside-authored text hold live fence rows: ${list}${items.length > 5 ? `; and ${items.length - 5} more` : ''}. `
        + 'A sender could plant these before this release, and extract_facts indexes them; gbrain writers also add rows on purpose. '
        + 'Review each page with the user; nothing is removed automatically.',
      fix: { argv: ['gbrain', 'get', '--source', first.source_id, '--', first.slug], consent: [], actor: 'agent', ask_user: true, requires_exclusive: false,
        why: `Shows ${first.source_id}:${first.slug} so the user can say which fence rows a sender wrote; a planted fact is withdrawn with gbrain forget after they agree. Repeat per page in details.items.`,
        verify: doctorVerify(NAME) } }, segmented));
  } catch (error) {
    checks.push(checkError(NAME, 'scan imported pages for live fence rows', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const outsideContentFencesEntry: DoctorEntry = { name: 'outside_content_fences', emits: ['outside_content_fences'], run: runOutsideContentFences };
