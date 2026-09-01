import type { SearchOpts } from '../types.ts';

/** In-memory parity with SQL type/expandedTypes gates for injected results. */
export function matchesSearchTypeFilters(
  type: string | null | undefined,
  frontmatter: Record<string, unknown> | null | undefined,
  opts: Pick<SearchOpts, 'type' | 'types' | 'expandedTypes'>,
): boolean {
  if (opts.type && type !== opts.type) return false;
  if (opts.types && opts.types.length > 0 && (type == null || !opts.types.includes(type as never))) return false;
  if (opts.expandedTypes && opts.expandedTypes.length > 0) {
    if (type == null) return false;
    return opts.expandedTypes.some((filter) => {
      if (!filter.isAliasExpansion || !filter.subtypeFilter) return type === filter.originalInput;
      return type === filter.originalInput || (
        type === filter.subtypeFilter.canonical &&
        frontmatter?.[filter.subtypeFilter.subtypeField] === filter.subtypeFilter.subtypeValue
      );
    });
  }
  return true;
}
