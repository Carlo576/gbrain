/**
 * #7841: a page write whose content asks for `visibility: private` publishes a
 * private page or is refused (`visibility_not_applied`); it never commits, or
 * comes back as a no-op, with the page still world-readable.
 *
 * The request is read from the content's leading frontmatter block line by line,
 * independently of the YAML parse, so a request the parse does not keep is still
 * seen: a key or value in another case (`Visibility: private`,
 * `visibility: Private`, which page privacy does not read as private), or a line
 * the parse drops. Only a request for `private` is checked, so the guard can only
 * refuse: it never widens a page and never changes what a remote caller may read
 * or write. A request that is kept passes unchanged.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { WriteRequest } from './model.ts';

/** The values the content's frontmatter gives `visibility` (top-level key, any case), lowercased; empty without a closed block. */
export function declaredVisibilities(content: string): string[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.trim() !== '---') return [];
  const values: string[] = [];
  for (i++; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i]!)) return values;
    const m = /^(["']?)visibility\1\s*:(.*)$/i.exec(lines[i]!);
    if (m) values.push(m[2]!.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase());
  }
  return [];
}

/** Refuses a write whose content asks for `visibility: private` when `published` (the frontmatter it would store) is not private. */
export function assertPrivateRequestKept(row: Pick<WriteRequest, 'slug' | 'source_id'>, content: string, published: Record<string, unknown> | null | undefined): void {
  if (!declaredVisibilities(content).includes('private') || published?.visibility === 'private') return;
  throw visibilityNotApplied(row, typeof published?.visibility === 'string' && published.visibility.trim().toLowerCase() === 'private'
    || Object.keys(published ?? {}).some(key => key !== 'visibility' && key.toLowerCase() === 'visibility') ? 'noncanonical_value' : 'not_kept');
}

function visibilityNotApplied(row: Pick<WriteRequest, 'slug' | 'source_id'>, reason: 'noncanonical_value' | 'not_kept'): OperationError {
  const cause = reason === 'noncanonical_value'
    ? 'Its frontmatter spells the key or value in another case, which page privacy does not read as private.'
    : 'Its frontmatter asks for private, but the page as it would be stored does not carry visibility: private.';
  return opError('visibility_not_applied', `The write asks for visibility: private, but page ${row.slug} would stay world-readable, so nothing was written (${reason}). Write visibility: private on its own frontmatter line, lowercase, and submit again.`,
    `${cause} Page ${row.slug} in source ${row.source_id} is unchanged. Read it and its revision, write \`visibility: private\` on its own frontmatter line (lowercase key and value), and submit again with a new request_id.`,
    { reason, docs: 'docs/guides/write-refusals.md#visibility_not_applied',
      fix: readFix(`Shows page ${row.slug} in source ${row.source_id} as it is now, with its revision.`,
        { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug], mcp: { tool: 'get_page', arguments: { slug: row.slug, source_id: row.source_id } } }) });
}
