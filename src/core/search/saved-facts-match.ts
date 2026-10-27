/**
 * The saved facts `search` and `query` report beside their rows
 * (`retrieval.saved_facts`, after the facts of the entity the query names):
 * active facts that share the query's words, matched as stemmed whole words.
 * `search.saved_facts_supersede` (default off) adds correction-cue ordering.
 * Tests: test/search-saved-facts-match.test.ts, test/search-saved-facts.test.ts,
 * test/search/saved-facts-probe.test.ts.
 */
import type { OperationContext } from '../ops/contract.ts';
import type { TrustTier } from '../trust/tier.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { collapseFactReads } from '../facts/capture-dedup.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { factsFtsDocument, getFtsLanguage } from '../fts-language.ts';
import { hasCJK } from '../cjk.ts';
import { privateProvenanceFilterFragment, resolveExcludePrivatePages } from './private-visibility.ts';
import { SAVED_FACT_COLLAPSE_COLUMNS, type CollapseColumns } from './entity-facts.ts';

/** Words too common to count toward a saved-fact match; also the coverage relevance stopwords in ops/search.ts. */
export const FACT_MATCH_STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their', 'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next']);

export interface SavedFactMatch { id: number; fact: string; entity_slug: string | null; kind: string; valid_from: string; source: string;
  /** #7043: every entity of the copies this row stands for, and how many rows it stands for. */
  entity_slugs?: string[]; collapsed_count?: number;
  /** With `search.saved_facts_supersede` on: the newer returned fact that corrects this one. */
  corrected_by?: number }

/** Default off: a newer saved fact carrying a correction cue is returned ahead of the older fact it corrects, which is labelled `corrected_by`. */
export const SAVED_FACTS_SUPERSEDE_KEY = 'search.saved_facts_supersede';
/** What marks a saved fact as a correction (Postgres ARE, matched case-insensitively). */
const CORRECTION_CUE = String.raw`\m(correction|corrected|correcting|retract(s|ed|ing|ion)?|disregard|scratch that|i misspoke|i was wrong|not what (i|we) (posted|said|wrote)|ignore (the|my|that|what))\M`;

async function savedFactsSupersedeEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(SAVED_FACTS_SUPERSEDE_KEY))?.trim().toLowerCase();
    return raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes';
  } catch {
    return false;
  }
}

/**
 * Facts saved with `remember` live in the facts table, not in page chunks, so
 * page search never returns them (gbrain-evals Cat 40: agents saved a
 * correction with remember and the next session's search missed it). This
 * finds active facts that contain at least three quarters of the query's words
 * (two of a two- or three-word query), under the same source scope and
 * visibility rules recall applies, copies of one claim collapsed before the cap
 * (#7043).
 * Words match whole after stemming with the brain's full-text language, as the
 * facts keyword index does: "renews" finds "renewal", and "count" never matches
 * inside "countersigned". CJK words, which that parser does not split, match as
 * substrings. Most matched words first, then newest. With
 * `search.saved_facts_supersede` on, a newer fact with a correction cue that
 * shares at least two matched words with a returned fact is returned too, and
 * every fact it corrects moves below the facts nothing corrects, labelled
 * `corrected_by`.
 */
export async function matchingSavedFacts(ctx: OperationContext, scope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier }, queryText: string, otherNames: string[] = []): Promise<Array<SavedFactMatch & CollapseColumns>> {
  // A query naming one of two declared names also matches facts saved under the other.
  if (otherNames.length) queryText += ` ${otherNames.join(' ')}`;
  const terms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])]
    .filter(t => t.length >= 3 && !FACT_MATCH_STOPWORDS.has(t)).slice(0, 12);
  if (terms.length === 0 || !ctx.emitResponseMeta) return [];
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? ctx.sourceId ?? 'default'];
  const [excludePrivate, supersede] = await Promise.all([resolveExcludePrivatePages(ctx.engine, ctx.remote), savedFactsSupersedeEnabled(ctx.engine)]);
  const active = `f.source_id = ANY($1::text[])
         AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.source != ALL($2::text[])
         ${ctx.remote !== false ? `AND f.visibility = 'world'` : ''}`;
  const eligible = `${excludePrivate ? `AND ${privateProvenanceFilterFragment('f')}` : ''}
         AND ${projectionEligibleSql('facts', 'f', { floor: scope.minTrust })}`;
  const lang = getFtsLanguage();
  const doc = factsFtsDocument('f');
  try {
    // Most searches have no saved fact to find: the uncorrelated EXISTS is an indexed probe
    // (idx_facts_since) the planner runs once, before the keyword scan, and the scan is skipped
    // when no fact qualifies; one statement, so one round trip either way. The probe reads the
    // fact's own columns only: every row the scan returns passes it, so it never changes the
    // result, and the page-eligibility filters stay on the scan, where they cost an index
    // lookup per candidate. The any-word tsquery reads the facts keyword index's own expression.
    // A word the language drops as a stopword counts toward neither side of the threshold.
    // The threshold is applied before the cut: a fact matching every word is never crowded
    // out by newer facts that match fewer.
    const rows = await ctx.engine.executeRaw<SavedFactMatch & CollapseColumns & { at: unknown; matched: unknown[]; need: unknown; cue: boolean }>(
      `WITH w AS (
         SELECT t.i, t.pat, plainto_tsquery('${lang}'::regconfig, t.term) AS tq
         FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(term, pat, i)
         WHERE t.pat IS NOT NULL OR numnode(plainto_tsquery('${lang}'::regconfig, t.term)) > 0
       ), k AS (
         SELECT count(*)::int AS n,
           NULLIF(string_agg('(' || tq::text || ')', ' | ') FILTER (WHERE pat IS NULL), '')::tsquery AS anyq,
           COALESCE(array_agg(pat) FILTER (WHERE pat IS NOT NULL), '{}') AS pats
         FROM w
       )
       SELECT * FROM (
         SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source, f.valid_from AS at, ${SAVED_FACT_COLLAPSE_COLUMNS},
           ARRAY(SELECT w.i FROM w WHERE CASE WHEN w.pat IS NOT NULL THEN lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) LIKE w.pat
             ELSE ${doc} @@ w.tq END ORDER BY w.i) AS matched,
           CASE WHEN k.n <= 3 THEN LEAST(2, k.n) ELSE ceil(k.n * 0.75)::int END AS need,
           ($6::boolean AND f.fact ~* $5) AS cue
         FROM facts f, k
         WHERE ${active}
           ${eligible}
           AND (${doc} @@ k.anyq OR lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) LIKE ANY(k.pats))
           AND EXISTS (SELECT 1 FROM facts f WHERE ${active} LIMIT 1)
       ) m
       WHERE cardinality(m.matched) >= CASE WHEN m.cue THEN LEAST(2, m.need) ELSE m.need END
       ORDER BY cardinality(m.matched) DESC, m.at DESC, m.id DESC
       LIMIT 200`,
      [sources, [...AUDIT_ROW_SOURCES], terms, terms.map(t => hasCJK(t) ? `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%` : null), CORRECTION_CUE, supersede],
    );
    const found = rows.map(({ at, matched, need, cue, ...fact }) => ({ fact: { ...fact, id: Number(fact.id) } as SavedFactMatch & CollapseColumns,
      at: new Date(at as string).getTime(), words: new Set(matched.map(Number)), need: Number(need), cue }));
    const admitted = found.filter(r => r.words.size >= r.need);
    if (supersede) {
      for (const older of admitted) {
        // Posts saved in one flush share a time; the later id is the later post.
        const correction = found.filter(n => n.cue && (n.at > older.at || (n.at === older.at && n.fact.id > older.fact.id))
          && [...n.words].filter(w => older.words.has(w)).length >= Math.min(2, n.need)).sort((a, b) => b.at - a.at || b.fact.id - a.fact.id)[0];
        if (correction) older.fact.corrected_by = correction.fact.id;
      }
      const correcting = new Set(admitted.flatMap(r => r.fact.corrected_by ? [r.fact.corrected_by] : []));
      admitted.push(...found.filter(r => correcting.has(r.fact.id) && r.words.size < r.need));
    }
    const ordered = supersede ? [...admitted.filter(r => !r.fact.corrected_by), ...admitted.filter(r => r.fact.corrected_by)] : admitted;
    return (await collapseFactReads(ctx.engine, ordered.map(r => r.fact))).slice(0, 5);
  } catch {
    return [];
  }
}
