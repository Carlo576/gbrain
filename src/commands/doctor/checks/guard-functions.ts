/**
 * guard_functions doctor check (#7632): the purge and withdrawal guards read their ledgers as their owner.
 *
 * Postgres only (PGLite has one role). Fails when one of the seven guards is not SECURITY DEFINER with search_path
 * `pg_catalog, public, pg_temp`, is executable by PUBLIC/anon/authenticated, or is owned by a role that does not
 * bypass RLS on a table it reads; when a raising guard's trigger still fires BEFORE ROW or the derivation guard's
 * trigger lacks its gbrain_caller_sees_page gate; or when any gbrain function's search_path still ends without pg_temp.
 * Migration v276 makes every change the migrating role owns and names the rest on stderr: this check carries the SQL
 * for them, to run as the owning role. Read-only.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';
import { AFTER_ROW_PURGE_TRIGGERS, DEFINER_GUARDS, GUARD_SEARCH_PATH, LEGACY_SEARCH_PATH_SETTINGS } from '../../../core/guard-definer.ts';
import { DERIVATION_GUARD_GATE_SQL, DERIVATION_GUARD_TRIGGER_SQL } from '../../../core/page-body/schema.ts';

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
      fix.push(`ALTER FUNCTION ${g.fn}() SECURITY DEFINER SET search_path = ${GUARD_SEARCH_PATH};`);
    }
    if (g.executable_by.length > 0) {
      problems.push(`${g.fn}() is executable by ${g.executable_by.join(', ')}`);
      fix.push(`REVOKE EXECUTE ON FUNCTION ${g.fn}() FROM ${g.executable_by.join(', ')};`);
    }
    if (g.reads_under_rls.length > 0) {
      problems.push(`${g.fn}()'s owner ${g.owner} neither bypasses RLS nor owns ${g.reads_under_rls.join(', ')} unforced, so the guard reads them filtered`);
      fix.push(`-- give ${g.fn}() an owner that bypasses RLS (ALTER FUNCTION ${g.fn}() OWNER TO <owner of the tables>), or ALTER ROLE ${g.owner} BYPASSRLS;`);
    }
  }
  const triggers = await engine.executeRaw<{ trigger: string; before: boolean; gated: boolean }>(
    `SELECT t.tgname AS trigger, (t.tgtype & 2) <> 0 AS before, pg_get_triggerdef(t.oid) LIKE '%gbrain_caller_sees_page(%' AS gated
       FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[])`,
    [[...AFTER_ROW_PURGE_TRIGGERS.map(t => t.trigger), 'page_segment_derivations_refuse_purging']]);
  for (const t of AFTER_ROW_PURGE_TRIGGERS) {
    if (!triggers.some(row => row.trigger === t.trigger && row.before)) continue;
    problems.push(`${t.trigger} on ${t.table} still fires BEFORE ROW`);
    fix.push(t.sql);
  }
  if (triggers.some(row => row.trigger === 'page_segment_derivations_refuse_purging' && !row.gated)) {
    problems.push('page_segment_derivations_refuse_purging has no gbrain_caller_sees_page gate');
    fix.push(DERIVATION_GUARD_GATE_SQL, DERIVATION_GUARD_TRIGGER_SQL);
  }
  const unpinned = await engine.executeRaw<{ sig: string; path: string }>(
    `SELECT p.oid::regprocedure::text AS sig, substr(c.setting, 13) AS path
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS c(setting)
      WHERE n.nspname = 'public' AND c.setting = ANY($1::text[]) ORDER BY 1`, [[...LEGACY_SEARCH_PATH_SETTINGS]]);
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
