import type { SearchOpts } from '../types.ts';
import { buildExpandedTypesSql } from '../schema-pack/expand-type-filter.ts';

/** Append one SQL-level OR filter for canonical and legacy type identities. */
export function appendSearchTypesClause(
  params: unknown[],
  opts: Pick<SearchOpts, 'types' | 'expandedTypes'> | undefined,
  pageAlias: string = 'p',
): string {
  if (opts?.expandedTypes && opts.expandedTypes.length > 0) {
    const built = buildExpandedTypesSql(opts.expandedTypes, params.length + 1, pageAlias);
    params.push(...built.params);
    return `AND ${built.sql}`;
  }
  if (opts?.types && opts.types.length > 0) {
    params.push(opts.types);
    return `AND ${pageAlias}.type = ANY($${params.length}::text[])`;
  }
  return '';
}
