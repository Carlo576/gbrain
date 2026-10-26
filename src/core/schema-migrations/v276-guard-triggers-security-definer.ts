import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { migrationStatementTimeoutMs } from '../migration-timeout.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from '../postgres-engine/schema-lock-timeout.ts';
import {
  DEFINER_FUNCTION_SQL, DEFINER_GUARDS, DEFINER_TRIGGERS, FUNCTION_SEARCH_PATH_HARDENING_SQL, LEGACY_SEARCH_PATH_SETTINGS,
} from '../guard-definer.ts';
import { DERIVATION_SCOPE_ENTRY_FUNCTION_SQL, DERIVATION_STORED_GUARD_FUNCTION_SQL, DERIVATION_STORED_GUARD_TRIGGER_SQL } from '../page-body/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7632: the purge and withdrawal guards read their ledgers as their owner (SECURITY DEFINER), so a write role without
// a policy on a ledger no longer slips a purged claim, page, take or derivation, or a withdrawn fact, past them. The
// rest of the change keeps that from widening anyone's reach (src/core/guard-definer.ts): each definer is rewritten with
// search_path = pg_catalog, pg_temp and every gbrain name schema-qualified, pg_temp is appended to every other gbrain
// function's path, EXECUTE is revoked from PUBLIC/anon/authenticated, and every definer that refuses fires AFTER ROW or
// AFTER STATEMENT, so a definer never answers a role RLS refuses. The guards that silently correct a row stay master's
// invokers. Function and trigger DDL needs the owner: a function or table the role does not own is skipped and named on
// stderr, as v275 does, and doctor's guard_functions check keeps failing with the fix until it is done. Each function
// and each table is its own short transaction with the migration's statement and lock timeouts.

/** Every definer guard's CREATE OR REPLACE (body, pinned path, revoke), by function. */
export const GUARD_FUNCTION_SQL: Readonly<Record<string, string>> = {
  ...DEFINER_FUNCTION_SQL,
  gbrain_mark_derivation_scope_entry: DERIVATION_SCOPE_ENTRY_FUNCTION_SQL,
  gbrain_refuse_stored_purging_derivation: DERIVATION_STORED_GUARD_FUNCTION_SQL,
};

/** The definer guards' triggers, each AFTER; its table step creates the function and the trigger together. */
export const GUARD_TRIGGERS: ReadonlyArray<{ table: string; trigger: string; fn: string; sql: string }> = [
  ...DEFINER_TRIGGERS,
  { table: 'page_segment_derivations', trigger: 'page_segment_derivations_refuse_stored_purging', fn: 'gbrain_refuse_stored_purging_derivation', sql: DERIVATION_STORED_GUARD_TRIGGER_SQL },
];

async function inShortTransaction(engine: BrainEngine, step: string, sql: string): Promise<void> {
  const lockTimeoutMs = resolveSchemaLockTimeoutMs();
  try {
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw(`SET LOCAL statement_timeout = '${migrationStatementTimeoutMs()}'`);
        await tx.executeRaw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      }
      await tx.runMigration(276, sql);
    });
  } catch (error) {
    if (isLockTimeoutError(error)) throw schemaLockBlockedError({ step, timeoutMs: lockTimeoutMs, sessions: null, sampledDuringWait: false });
    throw error;
  }
}

/**
 * For each guard trigger on a table the role owns, creates its definer function and moves or creates the trigger in
 * one transaction; then rewrites every other definer guard the role owns, unless its trigger still fires BEFORE ROW
 * (the role could not move it), so a definer never answers before RLS; then appends pg_temp to every gbrain function's
 * search_path. Names on stderr what it could not change (a guard whose table step was skipped may be absent) and
 * returns those names.
 */
export async function hardenGuards(engine: BrainEngine, label: string): Promise<string[]> {
  const skipped: string[] = [];
  const done = new Set<string>();
  const tables = await engine.executeRaw<{ name: string; owned: boolean | null }>(
    `SELECT t.name, pg_has_role(current_user, c.relowner, 'USAGE') AS owned
       FROM unnest($1::text[]) AS t(name) JOIN pg_class c ON c.oid = to_regclass(t.name)`,
    [[...new Set(GUARD_TRIGGERS.map(t => t.table))]]);
  for (const t of GUARD_TRIGGERS) {
    const table = tables.find(row => row.name === t.table);
    if (!table) continue;
    if (!table.owned) { skipped.push(`${t.trigger} on ${t.table}`); continue; }
    await inShortTransaction(engine, `${label} on ${t.table}`, `${GUARD_FUNCTION_SQL[t.fn]}\n${t.sql}`);
    done.add(t.fn);
  }
  const exposed = new Set((await engine.executeRaw<{ fn: string }>(
    `SELECT DISTINCT p.proname AS fn FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname = ANY($1::text[]) AND (t.tgtype & 2) <> 0`,
    [GUARD_TRIGGERS.map(t => t.fn)])).map(r => r.fn));
  const functions = await engine.executeRaw<{ fn: string; owned: boolean | null }>(
    `SELECT f.fn, pg_has_role(current_user, p.proowner, 'USAGE') AS owned
       FROM unnest($1::text[]) AS f(fn) LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn || '()') ORDER BY f.fn`,
    [DEFINER_GUARDS.map(g => g.fn).filter(fn => !done.has(fn))]);
  for (const { fn, owned } of functions) {
    if (owned && !exposed.has(fn)) await inShortTransaction(engine, `${label} on ${fn}()`, GUARD_FUNCTION_SQL[fn]!);
    else skipped.push(`${fn}()`);
  }
  await inShortTransaction(engine, `${label} search_path`, FUNCTION_SEARCH_PATH_HARDENING_SQL);
  const unhardened = await engine.executeRaw<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proconfig && $1::text[] ORDER BY 1`, [[...LEGACY_SEARCH_PATH_SETTINGS]]);
  skipped.push(...unhardened.map(r => r.sig));
  if (skipped.length > 0) {
    process.stderr.write(`  ${label}: ${skipped.length} function(s) or trigger(s) left as they were (${skipped.join(', ')}): `
      + 'the role must own them, and a guard its trigger\'s table. Run gbrain doctor for the fix.\n');
  }
  return skipped;
}

export const v276: Migration = {
  version: 276,
  name: 'guard_triggers_security_definer',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => { await hardenGuards(engine, 'v276'); },
};
