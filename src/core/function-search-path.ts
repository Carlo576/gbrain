/**
 * Every gbrain function that pins a search_path ends it with pg_temp (#7632).
 *
 * A pinned `pg_catalog, public` (or `pg_catalog`) does not name pg_temp, and PostgreSQL then searches the calling
 * session's temporary schema first for tables and views. Any role that may create temporary tables (PUBLIC may, by
 * default) could shadow a ledger a guard reads, such as fact_purges, page_purges, take_purges or fact_withdrawals, with an
 * empty temp table or view of the same name, and the guard let a purged claim, page or take, or a withdrawn fact,
 * through: for the owner as much as for any other writer. Named last, pg_temp comes after every other schema for
 * relations, and PostgreSQL never searches it for functions or operators.
 *
 * ALTER FUNCTION only: no body is rewritten, so every guard keeps master's body, SECURITY INVOKER and BEFORE ROW timing.
 * A write role with no policy on a ledger still reads it empty under its own RLS; that fail-open stays open (#7659).
 */

/** The search_path settings gbrain functions pinned before #7632, which the hardening completes with pg_temp. */
export const LEGACY_SEARCH_PATH_SETTINGS = ['search_path=pg_catalog, public', 'search_path=pg_catalog'] as const;

/**
 * Appends pg_temp to the pinned search_path of every function in public the current role may alter that still pins
 * `pg_catalog, public` or `pg_catalog` (every gbrain function that pins one did). A function the role does not own is
 * left as it was. Shared by the schema blob (its last statement, so a replay's CREATE OR REPLACE never leaves a function
 * without it), the migration and `gbrain reindex-search-vector`, which rewrites the search_vector trigger functions.
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
