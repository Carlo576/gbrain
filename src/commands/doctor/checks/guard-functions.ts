/**
 * guard_functions doctor check (#7632): the purge and withdrawal guards read their ledgers as their owner.
 *
 * Postgres only (PGLite has one role). Fails when one of the seven guards is not SECURITY DEFINER with search_path
 * `pg_catalog, pg_temp` (an older gbrain booting against the brain re-creates gbrain_mark_derivation_scope_entry as
 * an invoker), is executable by PUBLIC/anon/authenticated, or is owned by a role that does not bypass RLS on a table it
 * reads; when a guard's trigger is missing or fires BEFORE ROW; or when any gbrain function's search_path still ends
 * without pg_temp.
 * Migration v276 makes every change the migrating role owns and names the rest on stderr: this check carries the SQL
 * for them, to run as the owning role. Read-only.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';
import { DEFINER_GUARDS, GUARD_SEARCH_PATH, LEGACY_SEARCH_PATH_SETTINGS } from '../../../core/guard-definer.ts';
import { GUARD_FUNCTION_SQL, GUARD_TRIGGERS } from '../../../core/schema-migrations/v276-guard-triggers-security-definer.ts';

interface GuardRow { fn: string; secdef: boolean; pinned: boolean; executable_by: string[]; owner: string; reads_under_rls: string[] }

/** What is wrong with the guards on this brain, and the SQL that fixes each, in order. Empty when nothing is. */
export async function guardFunctionProblems(engine: BrainEngine): Promise<{ problems: string[]; fix: string[] }> {
  const problems: string[] = [];
  const fix: string[] = [];
  const reads = DEFINER_GUARDS.map(g => g.reads.join(','));
  const guards = await engine.executeRaw<GuardRow>(
    `SELECT f.fn, p.prosecdef AS secdef, COALESCE(p.proconfig @> ARRAY[$3::text], false) AS pinned, pg_get_userbyid(p.proowner) AS owner,
       ARRAY(SELECT 'PUBLIC' WHERE EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
             UNION ALL SELECT r.rolname::text FROM pg_roles r
               WHERE r.rolname IN ('anon', 'authenticated') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS executable_by,
       ARRAY(SELECT c.relname::text FROM unnest(string_to_array(f.reads, ',')) AS t(name) JOIN pg_class c ON c.oid = to_regclass(t.name)
               JOIN pg_roles o ON o.oid = p.proowner
              WHERE c.relrowsecurity AND NOT o.rolsuper AND NOT o.rolbypassrls AND (c.relowner <> p.proowner OR c.relforcerowsecurity)
              ORDER BY 1) AS reads_under_rls
       FROM unnest($1::text[], $2::text[]) AS f(fn, reads) JOIN pg_proc p ON p.oid = to_regprocedure(f.fn || '()') ORDER BY f.fn`,
    [DEFINER_GUARDS.map(g => g.fn), reads, `search_path=${GUARD_SEARCH_PATH}`]);
  for (const g of guards) {
    if (!g.secdef || !g.pinned) {
      problems.push(`${g.fn}() is not SECURITY DEFINER with search_path ${GUARD_SEARCH_PATH}`);
      fix.push(GUARD_FUNCTION_SQL[g.fn]!);
    }
    if (g.executable_by.length > 0) {
      problems.push(`${g.fn}() is executable by ${g.executable_by.join(', ')}`);
      fix.push(`REVOKE EXECUTE ON FUNCTION ${g.fn}() FROM ${g.executable_by.join(', ')};`);
    }
    if (g.reads_under_rls.length > 0) {
      problems.push(`${g.fn}()'s owner ${g.owner} neither bypasses RLS nor owns ${g.reads_under_rls.join(', ')} unforced, so the guard reads them filtered`);
      fix.push(`/* give ${g.fn}() an owner that bypasses RLS and is not the role gbrain runs as, so that role stays under its policies: ALTER FUNCTION ${g.fn}() OWNER TO <that role>; */`);
    }
  }
  const triggers = await engine.executeRaw<{ table: string; trigger: string; before: boolean | null }>(
    `SELECT t.name AS table, g.tgname AS trigger, (g.tgtype & 2) <> 0 AS before
       FROM unnest($1::text[]) AS t(name) JOIN pg_class c ON c.oid = to_regclass(t.name)
       LEFT JOIN pg_trigger g ON g.tgrelid = c.oid AND NOT g.tgisinternal AND g.tgname = ANY($2::text[])`,
    [[...new Set(GUARD_TRIGGERS.map(t => t.table))], GUARD_TRIGGERS.map(t => t.trigger)]);
  for (const t of GUARD_TRIGGERS) {
    if (!triggers.some(row => row.table === t.table)) continue;
    const row = triggers.find(r => r.trigger === t.trigger);
    if (row && !row.before) continue;
    problems.push(row ? `${t.trigger} on ${t.table} still fires BEFORE ROW` : `${t.table} has no ${t.trigger} AFTER check`);
    fix.push(`${GUARD_FUNCTION_SQL[t.fn]}\n${t.sql}`);
  }
  const unpinned = await engine.executeRaw<{ sig: string; path: string }>(
    `SELECT p.oid::regprocedure::text AS sig, substr(c.setting, 13) AS path
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS c(setting)
      WHERE n.nspname = 'public' AND c.setting = ANY($1::text[]) AND p.proname <> ALL($2::text[]) ORDER BY 1`,
    [[...LEGACY_SEARCH_PATH_SETTINGS], DEFINER_GUARDS.map(g => g.fn)]);
  if (unpinned.length > 0) {
    problems.push(`${unpinned.length} function(s) pin search_path without pg_temp last (${unpinned.map(u => u.sig).join(', ')})`);
    fix.push(...unpinned.map(u => `ALTER FUNCTION ${u.sig} SET search_path = ${u.path}, pg_temp;`));
  }
  return { problems, fix };
}

async function runGuardFunctions(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('guard_functions');
  if (engine.kind !== 'postgres') {
    checks.push({ name: 'guard_functions', status: 'ok', message: 'Skipped (PGLite: one role, so every guard reads every row)' });
    return checks;
  }
  try {
    const { problems, fix } = await guardFunctionProblems(engine);
    if (problems.length === 0) {
      checks.push({ name: 'guard_functions', status: 'ok', message: `The ${DEFINER_GUARDS.length} purge and withdrawal guards read their ledgers as their owner; every gbrain function pins pg_temp last` });
    } else {
      checks.push({
        name: 'guard_functions',
        status: 'fail',
        message: `${problems.length} guard problem(s): ${problems.join('; ')}. A write role without policies on a ledger can then store purged content or revive a withdrawn fact. `
          + `Fix (as the role that owns these functions and tables; migration v276 did what the migrating role owned): ${fix.join(' ')}`,
      });
    }
  } catch (e) {
    checks.push(checkError('guard_functions', 'check the purge and withdrawal guards', e));
  }
  return checks;
}

export const guardFunctionsEntry: DoctorEntry = { name: 'guard_functions', emits: ['guard_functions'], run: runGuardFunctions };
