/**
 * Guard trigger functions that read RLS-protected lookup tables run as their owner (#7632).
 *
 * The purge and withdrawal guards decide a write by reading another table (a purge or withdrawal ledger). As
 * SECURITY INVOKER they read it under the writing role's row-level security, so a role that may write the guarded
 * table but has no policy on the ledger read zero rows and the guard let the write through: a purged claim, page,
 * take or derivation was stored again, and a withdrawn fact was saved active. The definers below read the ledger as
 * their owner (the role that ran the migrations, which owns the tables and bypasses RLS) whatever the writer's
 * policies are.
 *
 * The trust model around that, each piece pinned by test/e2e/guard-definer-postgres.test.ts:
 * - A definer runs with search_path = pg_catalog, pg_temp and names every gbrain table and function as public.x.
 *   PostgreSQL never searches pg_temp for functions or operators, and public is off the path, so a role with CREATE
 *   on public (Supabase grants it to anon and authenticated) cannot plant an overload of a built-in the owner then
 *   runs; and pg_temp last keeps a caller's temp table or view named like a ledger out of every relation lookup.
 *   Every other gbrain function gets pg_temp appended (FUNCTION_SEARCH_PATH_HARDENING_SQL): an invoker guard can
 *   otherwise be walked past with a temp table named like its ledger. Those run as the caller, so an overload there
 *   runs with the caller's own rights.
 * - A definer never writes a table whose triggers run invoker functions: a definer's write fires them as the owner,
 *   with public on their path. Only gbrain_mark_derivation_scope_entry writes (page_segment_derivation_purge_pages,
 *   which has no trigger).
 * - EXECUTE is revoked from PUBLIC, anon and authenticated. A trigger function cannot be called directly anyway, and a
 *   trigger fires whatever the EXECUTE grants are.
 * - A definer never answers before RLS has accepted the row: BEFORE ROW triggers run before RLS WITH CHECK, so a
 *   definer there would tell a role with a bare INSERT grant (Supabase anon) purged content from other content, or a
 *   locked source from an absent one. Every definer that refuses fires AFTER ROW or AFTER STATEMENT. The guards that
 *   silently correct a row stay master's invokers, BEFORE ROW or writing as the writer: gbrain_refuse_purging_derivation
 *   drops a derivation a sweep would delete, gbrain_preserve_fact_withdrawal stamps a withdrawn fact expired, and
 *   gbrain_guard_inserted_facts refuses purged inserts and stamps withdrawn ones. A row they pass because the writer
 *   cannot read the ledger meets a definer after RLS: gbrain_refuse_stored_purging_derivation
 *   (derivation_purge_pending), gbrain_refuse_unguarded_inserted_facts and gbrain_refuse_revived_withdrawn_fact
 *   (purged_content, fact_withdrawn).
 *
 * What a writer gains: one fixed side effect the owner performs for it (adding its page to a running derivation
 * purge's page list) and knowing whether content it supplies is purged or withdrawn in a source it can already write.
 * anon and authenticated gain nothing: RLS refuses their row before any definer reads a ledger. A writer RLS accepts
 * but with no policy on a ledger is refused where it used to fail open, with an error instead of a silent drop or
 * stamp.
 */

/** The seven definer guards and the tables each reads, besides the one its trigger is on. */
export const DEFINER_GUARDS = [
  { fn: 'gbrain_mark_derivation_scope_entry', reads: ['page_segment_derivation_purges', 'page_segment_derivation_purge_pages'] },
  { fn: 'gbrain_refuse_purged_fact', reads: ['fact_purges', 'sources'] },
  { fn: 'gbrain_refuse_purged_page', reads: ['page_purges'] },
  { fn: 'gbrain_refuse_purged_take', reads: ['take_purges', 'pages'] },
  { fn: 'gbrain_refuse_revived_withdrawn_fact', reads: ['fact_withdrawals', 'sources'] },
  { fn: 'gbrain_refuse_stored_purging_derivation', reads: ['page_segment_derivation_purges', 'pages', 'page_body_manifest'] },
  { fn: 'gbrain_refuse_unguarded_inserted_facts', reads: ['fact_purges', 'fact_withdrawals', 'facts', 'sources'] },
] as const;

export const GUARD_SEARCH_PATH = 'pg_catalog, pg_temp';

/** The Data API roles Supabase grants EXECUTE on new functions through default privileges. */
const API_ROLES = ['anon', 'authenticated'] as const;

/** Revokes EXECUTE on a zero-argument function from PUBLIC and from the Data API roles that exist. */
export function revokeExecuteSql(fn: string): string {
  return `REVOKE EXECUTE ON FUNCTION ${fn}() FROM PUBLIC;
DO $revoke$ BEGIN
${API_ROLES.map(r => `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN REVOKE EXECUTE ON FUNCTION ${fn}() FROM ${r}; END IF;`).join('\n')}
END $revoke$;`;
}

/** Refuses an update into a purged claim; AFTER ROW, after RLS. Inserts meet gbrain_refuse_unguarded_inserted_facts. */
const REFUSE_PURGED_FACT_SQL = `CREATE OR REPLACE FUNCTION gbrain_refuse_purged_fact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH} AS $fn$
BEGIN
  PERFORM s.id FROM public.sources s WHERE s.id = NEW.source_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.fact_purges p
    WHERE p.source_id = NEW.source_id AND p.visibility = NEW.visibility
      AND (p.subject = '*'::text OR p.subject = NEW.entity_slug)
      AND p.fact_hash = public.gbrain_fact_fingerprint(NEW.fact)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'purged_content: this claim was purged from this source and cannot be saved again',
      DETAIL = json_build_object('table'::text, 'facts'::text, 'hash8'::text, left(public.gbrain_fact_fingerprint(NEW.fact), 8))::text;
  END IF;
  RETURN NULL;
END
$fn$;
${revokeExecuteSql('gbrain_refuse_purged_fact')}`;

const REFUSE_PURGED_TAKE_SQL = `CREATE OR REPLACE FUNCTION gbrain_refuse_purged_take() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH} AS $fn$
DECLARE src TEXT; subj TEXT;
BEGIN
  SELECT p.source_id, p.slug INTO src, subj FROM public.pages p WHERE p.id = NEW.page_id;
  IF src IS NOT NULL AND EXISTS (SELECT 1 FROM public.take_purges t
    WHERE t.source_id = src AND (t.subject = '*'::text OR t.subject = subj)
      AND t.claim_hash = public.gbrain_fact_fingerprint(NEW.claim)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'purged_content: this take claim was purged from this source and cannot be saved again',
      DETAIL = json_build_object('table'::text, 'takes'::text, 'hash8'::text, left(public.gbrain_fact_fingerprint(NEW.claim), 8))::text;
  END IF;
  RETURN NULL;
END
$fn$;
${revokeExecuteSql('gbrain_refuse_purged_take')}`;

const REFUSE_PURGED_PAGE_SQL = `CREATE OR REPLACE FUNCTION gbrain_refuse_purged_page() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH} AS $fn$
BEGIN
  -- No column list on the trigger: a column-scoped trigger would pin pages.source_id and content_hash.
  IF NEW.content_hash IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.source_id IS DISTINCT FROM OLD.source_id)
    AND EXISTS (SELECT 1 FROM public.page_purges p WHERE p.source_id = NEW.source_id AND p.content_hash = NEW.content_hash) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'purged_content: this page content was purged from this source and cannot be saved again',
      DETAIL = json_build_object('table'::text, 'pages'::text, 'hash8'::text, left(NEW.content_hash, 8))::text;
  END IF;
  RETURN NULL;
END
$fn$;
${revokeExecuteSql('gbrain_refuse_purged_page')}`;

/**
 * Refuses an update that leaves a withdrawn fact active. gbrain_preserve_fact_withdrawal (BEFORE ROW, invoker) stamps
 * it expired for a writer that can read fact_withdrawals, so only a writer that cannot meets this.
 */
const REFUSE_REVIVED_WITHDRAWN_FACT_SQL = `CREATE OR REPLACE FUNCTION gbrain_refuse_revived_withdrawn_fact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH} AS $fn$
BEGIN
  PERFORM s.id FROM public.sources s WHERE s.id = NEW.source_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.fact_withdrawals w
    WHERE w.source_id = NEW.source_id AND w.visibility = NEW.visibility
      AND (w.subject = '*'::text OR w.subject = NEW.entity_slug)
      AND w.fact_hash IN (public.gbrain_fact_fingerprint(NEW.fact), public.gbrain_fact_fingerprint_v1(NEW.fact))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'fact_withdrawn: this fact was withdrawn from this source and cannot be made active again';
  END IF;
  RETURN NULL;
END
$fn$;
${revokeExecuteSql('gbrain_refuse_revived_withdrawn_fact')}`;

/**
 * Refuses an insert that leaves a purged fact stored or a withdrawn fact active. Fires after facts_guard_inserted
 * (gbrain_guard_inserted_facts, invoker: it refuses and stamps what the writer can read), so only a writer that cannot
 * read the ledgers meets it. Reads only: a definer's write would run the facts triggers as the owner.
 */
const REFUSE_UNGUARDED_INSERTED_FACTS_SQL = `CREATE OR REPLACE FUNCTION gbrain_refuse_unguarded_inserted_facts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH} AS $fn$
DECLARE purged TEXT;
BEGIN
  PERFORM s.id FROM public.sources s WHERE s.id IN (SELECT i.source_id FROM inserted_facts i) ORDER BY s.id FOR SHARE OF s;
  IF EXISTS (SELECT 1 FROM public.fact_purges p WHERE p.source_id IN (SELECT i.source_id FROM inserted_facts i)) THEN
    SELECT n.fact_hash INTO purged FROM (SELECT i.source_id, i.visibility, i.entity_slug, public.gbrain_fact_fingerprint(i.fact) AS fact_hash
        FROM inserted_facts i) n
      WHERE EXISTS (SELECT 1 FROM public.fact_purges p WHERE p.source_id = n.source_id AND p.visibility = n.visibility
        AND p.subject IN ('*'::text, n.entity_slug) AND p.fact_hash = n.fact_hash)
      LIMIT 1;
    IF purged IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'purged_content: this claim was purged from this source and cannot be saved again',
        DETAIL = json_build_object('table'::text, 'facts'::text, 'hash8'::text, left(purged, 8))::text;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fact_withdrawals w WHERE w.source_id IN (SELECT i.source_id FROM inserted_facts i)) THEN
    IF EXISTS (SELECT 1 FROM inserted_facts i JOIN public.facts f ON f.id = i.id
      WHERE f.expired_at IS NULL AND EXISTS (SELECT 1 FROM public.fact_withdrawals w
        WHERE w.source_id = f.source_id AND w.visibility = f.visibility AND w.subject IN ('*'::text, f.entity_slug)
          AND w.fact_hash IN (public.gbrain_fact_fingerprint(f.fact), public.gbrain_fact_fingerprint_v1(f.fact)))) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'fact_withdrawn: this fact was withdrawn from this source and cannot be saved active';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
${revokeExecuteSql('gbrain_refuse_unguarded_inserted_facts')}`;

/** The definer guards on facts, takes and pages, by function: CREATE OR REPLACE with the body, then the revoke. */
export const DEFINER_FUNCTION_SQL: Readonly<Record<string, string>> = {
  gbrain_refuse_purged_fact: REFUSE_PURGED_FACT_SQL,
  gbrain_refuse_purged_take: REFUSE_PURGED_TAKE_SQL,
  gbrain_refuse_purged_page: REFUSE_PURGED_PAGE_SQL,
  gbrain_refuse_revived_withdrawn_fact: REFUSE_REVIVED_WITHDRAWN_FACT_SQL,
  gbrain_refuse_unguarded_inserted_facts: REFUSE_UNGUARDED_INSERTED_FACTS_SQL,
};

/**
 * Their triggers, all AFTER so RLS refuses a row first. The three purge triggers keep their events and columns; the
 * two new ones follow facts_guard_inserted and facts_preserve_withdrawal (AFTER STATEMENT triggers fire in name order).
 */
export const DEFINER_TRIGGERS = [
  { table: 'facts', trigger: 'facts_refuse_purged', fn: 'gbrain_refuse_purged_fact', sql: `DROP TRIGGER IF EXISTS facts_refuse_purged ON facts;
CREATE TRIGGER facts_refuse_purged AFTER UPDATE OF fact, source_id, visibility, entity_slug ON facts
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_fact();` },
  { table: 'takes', trigger: 'takes_refuse_purged', fn: 'gbrain_refuse_purged_take', sql: `DROP TRIGGER IF EXISTS takes_refuse_purged ON takes;
CREATE TRIGGER takes_refuse_purged AFTER INSERT OR UPDATE OF claim, page_id ON takes
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_take();` },
  { table: 'pages', trigger: 'pages_refuse_purged', fn: 'gbrain_refuse_purged_page', sql: `DROP TRIGGER IF EXISTS pages_refuse_purged ON pages;
CREATE TRIGGER pages_refuse_purged AFTER INSERT OR UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_page();` },
  { table: 'facts', trigger: 'facts_refuse_revived_withdrawal', fn: 'gbrain_refuse_revived_withdrawn_fact', sql: `DROP TRIGGER IF EXISTS facts_refuse_revived_withdrawal ON facts;
CREATE TRIGGER facts_refuse_revived_withdrawal AFTER UPDATE OF fact, source_id, visibility, entity_slug, expired_at ON facts
  FOR EACH ROW WHEN (NEW.expired_at IS NULL) EXECUTE FUNCTION gbrain_refuse_revived_withdrawn_fact();` },
  { table: 'facts', trigger: 'facts_refuse_unguarded_inserted', fn: 'gbrain_refuse_unguarded_inserted_facts', sql: `DROP TRIGGER IF EXISTS facts_refuse_unguarded_inserted ON facts;
CREATE TRIGGER facts_refuse_unguarded_inserted AFTER INSERT ON facts REFERENCING NEW TABLE AS inserted_facts
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_refuse_unguarded_inserted_facts();` },
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
