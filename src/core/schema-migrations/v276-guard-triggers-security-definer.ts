import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { migrationStatementTimeoutMs } from '../migration-timeout.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from '../postgres-engine/schema-lock-timeout.ts';
import {
  AFTER_ROW_PURGE_TRIGGERS, DEFINER_GUARDS, FUNCTION_SEARCH_PATH_HARDENING_SQL, LEGACY_SEARCH_PATH_SETTINGS, definerGuardSql,
} from '../guard-definer.ts';
import { DERIVATION_GUARD_GATE_SQL, DERIVATION_GUARD_TRIGGER_SQL } from '../page-body/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7632: the purge and withdrawal guards read their ledgers as their owner (SECURITY DEFINER), so a write role without
// a policy on a ledger no longer slips a purged claim, page, take or derivation, or a withdrawn fact, past them. The
// rest of the change keeps that from widening anyone's reach (src/core/guard-definer.ts): search_path pinned with
// pg_temp last on every gbrain function, EXECUTE revoked from PUBLIC/anon/authenticated, the raising guards moved to
// AFTER ROW and the BEFORE derivation guard gated on the writer seeing the page, so a definer never answers a role
// RLS refuses. ALTER and trigger DDL need the owner: a function or table the role does not own is skipped and named
// on stderr, as v275 does, and doctor's guard_functions check keeps failing with the fix until it is done. Each
// function and each table is its own short transaction with the migration's statement and lock timeouts.
const TRIGGERS: ReadonlyArray<{ table: string; trigger: string; sql: string }> = [
  ...AFTER_ROW_PURGE_TRIGGERS,
  { table: 'page_segment_derivations', trigger: 'page_segment_derivations_refuse_purging', sql: `${DERIVATION_GUARD_GATE_SQL}\n${DERIVATION_GUARD_TRIGGER_SQL}` },
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
 * Makes the purge and withdrawal guards definers, moves their triggers, and appends pg_temp to every gbrain function's
 * search_path, for what the role owns. Names on stderr what it could not change and returns those names.
 */
export async function hardenGuards(engine: BrainEngine, label: string): Promise<string[]> {
  const skipped: string[] = [];
  const functions = await engine.executeRaw<{ fn: string; owned: boolean | null }>(
    `SELECT f.fn, pg_has_role(current_user, p.proowner, 'USAGE') AS owned
       FROM unnest($1::text[]) AS f(fn) JOIN pg_proc p ON p.oid = to_regprocedure(f.fn || '()') ORDER BY f.fn`,
    [DEFINER_GUARDS.map(g => g.fn)]);
  for (const { fn, owned } of functions) {
    if (owned) await inShortTransaction(engine, `${label} on ${fn}()`, definerGuardSql(fn));
    else skipped.push(`${fn}()`);
  }
  const tables = await engine.executeRaw<{ name: string; owned: boolean | null }>(
    `SELECT t.name, pg_has_role(current_user, c.relowner, 'USAGE') AS owned
       FROM unnest($1::text[]) AS t(name) JOIN pg_class c ON c.oid = to_regclass(t.name)`,
    [TRIGGERS.map(t => t.table)]);
  const ownedTables = new Set(tables.filter(t => t.owned).map(t => t.name));
  for (const t of TRIGGERS) {
    if (!tables.some(row => row.name === t.table)) continue;
    if (ownedTables.has(t.table)) await inShortTransaction(engine, `${label} on ${t.table}`, t.sql);
    else skipped.push(`${t.trigger} on ${t.table}`);
  }
  await inShortTransaction(engine, `${label} search_path`, FUNCTION_SEARCH_PATH_HARDENING_SQL);
  const unhardened = await engine.executeRaw<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proconfig && $1::text[] ORDER BY 1`, [[...LEGACY_SEARCH_PATH_SETTINGS]]);
  skipped.push(...unhardened.map(r => r.sig));
  if (skipped.length > 0) {
    process.stderr.write(`  ${label}: ${skipped.length} guard function(s) or trigger(s) left as they were (${skipped.join(', ')}): `
      + 'the role must own them. Run gbrain doctor for the fix.\n');
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
