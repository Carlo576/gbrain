import type { BrainEngine } from '../engine.ts';
import type { SearchOpts, SearchResult } from '../types.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { matchesSearchTypeFilters } from './type-filter-match.ts';

const ALIAS_HOP_PRESENT_BOOST = 1.10;
const MAX_ALIAS_QUERY_TOKENS = 6;
const MAX_ALIAS_INJECT = 3;

/** Boost or inject a page whose declared alias exactly matches the query. */
export async function applyAliasHop(
  engine: BrainEngine,
  results: SearchResult[],
  query: string,
  opts: Pick<SearchOpts, 'type' | 'types' | 'expandedTypes'> & {
    sourceId?: string;
    sourceIds?: string[];
    excludePrivate?: boolean;
    excludeSlugs?: string[];
  },
): Promise<SearchResult[]> {
  if (!query) return results;
  const qNorm = normalizeAlias(query);
  if (!qNorm || qNorm.split(' ').length > MAX_ALIAS_QUERY_TOKENS) return results;

  let aliasMap: Map<string, Array<{ slug: string; source_id: string }>>;
  try {
    aliasMap = await engine.resolveAliases([qNorm], { sourceId: opts.sourceId, sourceIds: opts.sourceIds });
  } catch {
    return results;
  }
  const refs = aliasMap.get(qNorm);
  if (!refs || refs.length === 0) return results;
  const ordered = [...refs]
    .sort((a, b) => (a.source_id === b.source_id ? a.slug.localeCompare(b.slug) : a.source_id.localeCompare(b.source_id)))
    .slice(0, MAX_ALIAS_INJECT);
  const out = [...results];
  const topScore = out.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), 0);
  let injectScore = topScore > 0 ? topScore : 1.0;

  for (const ref of ordered) {
    const idx = out.findIndex((r) => r.slug === ref.slug && (r.source_id ?? 'default') === ref.source_id);
    if (idx >= 0) {
      if (Number.isFinite(out[idx].score)) out[idx].score *= ALIAS_HOP_PRESENT_BOOST;
      out[idx].alias_hit = true;
      continue;
    }
    let page;
    try {
      page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    } catch {
      continue;
    }
    if (!page) continue;
    if (opts.excludeSlugs?.includes(page.slug)) continue;
    if (!matchesSearchTypeFilters(page.type, page.frontmatter, opts)) continue;
    if (opts.excludePrivate && page.frontmatter?.visibility === 'private') continue;
    injectScore += 1e-6;
    out.push({
      page_id: page.id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      source_id: page.source_id ?? ref.source_id,
      chunk_text: (page.compiled_truth ?? '').slice(0, 200),
      chunk_index: 0,
      chunk_id: 0,
      score: injectScore,
      base_score: injectScore,
      alias_hit: true,
    } as SearchResult);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
