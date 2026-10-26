/**
 * Guard trigger functions that read RLS-protected lookup tables run as their owner (#7632).
 *
 * The purge and withdrawal guards decide a write by reading another table (a purge or withdrawal ledger). As
 * SECURITY INVOKER they read it under the writing role's row-level security, so a role that may write the guarded
 * table but has no policy on the ledger read zero rows and the guard let the write through: a purged claim, page,
 * take or derivation was stored again, and a withdrawn fact was saved active. As SECURITY DEFINER they read the
 * ledger as their owner (the role that ran the migrations, which owns the tables and bypasses RLS) whatever the
 * writer's policies are.
 *
 * The trust model around that, each piece pinned by test/e2e/guard-definer-postgres.test.ts:
 * - search_path is pinned with pg_temp LAST. PostgreSQL searches the caller's temp schema first for relations unless
 *   the path names it, so without it a caller's temp view named like a ledger would run the caller's code as the
 *   owner. Every other gbrain function gets pg_temp appended too (FUNCTION_SEARCH_PATH_HARDENING_SQL): an invoker
 *   guard can otherwise be walked past with a temp table named like its ledger.
 * - EXECUTE is revoked from PUBLIC, anon and authenticated. A trigger function cannot be called directly anyway, and a
 *   trigger fires whatever the EXECUTE grants are.
 * - A definer never answers before RLS has accepted the row. BEFORE ROW triggers run before RLS WITH CHECK, so a
 *   raising definer BEFORE guard would tell a role with a bare INSERT grant (Supabase anon) purged content from any
 *   other content. The raising guards fire AFTER ROW; the derivation guard must stay BEFORE (its callers count the
 *   rows it drops), so its trigger runs only WHEN the writing role can see the page (gbrain_caller_sees_page, an
 *   invoker helper). gbrain_preserve_fact_withdrawal stays BEFORE: it never raises, and its stamp is visible only on
 *   a row RLS accepted.
 *
 * What a writer gains: the two fixed side effects the definer bodies perform as the owner (expiring the facts its own
 * statement just inserted, adding its page to a running derivation purge's page list) and knowing whether content it
 * supplies is purged or withdrawn in a source it can already write.
 */

/** The seven guards and the tables each reads, besides the one its trigger is on. */
export const DEFINER_GUARDS = [
  { fn: 'gbrain_guard_inserted_facts', reads: ['fact_purges', 'fact_withdrawals', 'sources'] },
  { fn: 'gbrain_preserve_fact_withdrawal', reads: ['fact_withdrawals', 'sources'] },
  { fn: 'gbrain_refuse_purged_fact', reads: ['fact_purges', 'sources'] },
  { fn: 'gbrain_refuse_purged_page', reads: ['page_purges'] },
  { fn: 'gbrain_refuse_purged_take', reads: ['take_purges', 'pages'] },
  { fn: 'gbrain_refuse_purging_derivation', reads: ['page_segment_derivation_purges', 'pages', 'page_body_manifest'] },
  { fn: 'gbrain_mark_derivation_scope_entry', reads: ['page_segment_derivation_purges', 'page_segment_derivation_purge_pages'] },
] as const;

export const GUARD_SEARCH_PATH = 'pg_catalog, public, pg_temp';

/** The Data API roles Supabase grants EXECUTE on new functions through default privileges. */
const API_ROLES = ['anon', 'authenticated'] as const;

/** Revokes EXECUTE on a zero-argument function from PUBLIC and from the Data API roles that exist. */
export function revokeExecuteSql(fn: string): string {
  return `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC;
DO $revoke$ BEGIN
${API_ROLES.map(r => `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN REVOKE EXECUTE ON FUNCTION ${fn}() FROM ${r}; END IF;`).join('\n')}
END $revoke$;`;
}

/** Makes one guard a definer with the pinned path and revokes direct EXECUTE. */
export function definerGuardSql(fn: string): string {
  return `ALTER FUNCTION ${fn}() SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH};
${revokeExecuteSql(fn)}`;
}

/** The raising guards, AFTER ROW so RLS WITH CHECK runs first. Same events and columns as before. */
export const AFTER_ROW_PURGE_TRIGGERS = [
  { table: 'facts', trigger: 'facts_refuse_purged', sql: `DROP TRIGGER IF EXISTS facts_refuse_purged ON facts;
CREATE TRIGGER facts_refuse_purged AFTER UPDATE OF fact, source_id, visibility, entity_slug ON facts
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_fact();` },
  { table: 'takes', trigger: 'takes_refuse_purged', sql: `DROP TRIGGER IF EXISTS takes_refuse_purged ON takes;
CREATE TRIGGER takes_refuse_purged AFTER INSERT OR UPDATE OF claim, page_id ON takes
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_take();` },
  { table: 'pages', trigger: 'pages_refuse_purged', sql: `DROP TRIGGER IF EXISTS pages_refuse_purged ON pages;
CREATE TRIGGER pages_refuse_purged AFTER INSERT OR UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_page();` },
] as const;

/** The search_path settings gbrain functions pinned before #7632, which the hardening completes with pg_temp. */
export const LEGACY_SEARCH_PATH_SETTINGS = ['search_path=pg_catalog, public', 'search_path=pg_catalog'] as const;

/**
 * Appends pg_temp to the pinned search_path of every function in public the current role may alter that still pins
 * `pg_catalog, public` or `pg_catalog` (every gbrain function that pins one did). ALTER only: no body is rewritten.
 * Shared by the schema blob (its last statement, so a replay's CREATE OR REPLACE never leaves a function without it),
 * the migration and `gbrain reindex-search-vector`, which rewrites the search_vector trigger functions.
 */
export const FUNCTION_SEARCH_PATH_HARDENING_SQL = `DO $harden$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, substr(c.setting, 13) AS path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS c(setting)
    WHERE n.nspname = 'public' AND c.setting IN (${LEGACY_SEARCH_PATH_SETTINGS.map(v => `'${v}'`).join(', ')})
      AND pg_has_role(current_user, p.proowner, 'USAGE')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s, pg_temp', f.sig, f.path);
  END LOOP;
END $harden$;`;
