/**
 * #7632 on PGLite: one role, so the guards read every ledger row either way, but the catalog matches Postgres (the
 * guards are definers with pg_temp last on their path, the raising guard triggers fire AFTER ROW, the derivation guard's
 * BEFORE ROW drop is joined by its AFTER ROW check, every pinned search_path ends in pg_temp) and an AFTER ROW guard still refuses the write in the same statement.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DEFINER_GUARDS, GUARD_SEARCH_PATH } from '../src/core/guard-definer.ts';

describe('purge and withdrawal guard catalog on PGLite (#7632)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('guards are SECURITY DEFINER pinned with pg_temp last, and not executable by PUBLIC', async () => {
    const rows = await engine.executeRaw<{ fn: string; secdef: boolean; config: string[] | null; public_execute: boolean }>(
      `SELECT p.proname AS fn, p.prosecdef AS secdef, p.proconfig AS config,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
         FROM pg_proc p WHERE p.oid = ANY(SELECT to_regprocedure(g || '()') FROM unnest($1::text[]) g) ORDER BY 1`, [DEFINER_GUARDS.map(g => g.fn)]);
    expect(rows).toEqual([...DEFINER_GUARDS].map(g => g.fn).sort().map(fn => ({ fn, secdef: true, config: [`search_path=${GUARD_SEARCH_PATH}`], public_execute: false })));
  });

  test('the raising guards fire AFTER ROW and the derivation guard drops BEFORE ROW and checks AFTER ROW', async () => {
    const rows = await engine.executeRaw<{ trigger: string; timing: string }>(
      `SELECT tgname AS trigger, CASE WHEN (tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing FROM pg_trigger WHERE NOT tgisinternal
         AND tgname IN ('facts_refuse_purged', 'takes_refuse_purged', 'pages_refuse_purged', 'page_segment_derivations_refuse_purging', 'page_segment_derivations_refuse_stored_purging') ORDER BY 1`);
    expect(rows).toEqual([
      { trigger: 'facts_refuse_purged', timing: 'AFTER' },
      { trigger: 'page_segment_derivations_refuse_purging', timing: 'BEFORE' },
      { trigger: 'page_segment_derivations_refuse_stored_purging', timing: 'AFTER' },
      { trigger: 'pages_refuse_purged', timing: 'AFTER' },
      { trigger: 'takes_refuse_purged', timing: 'AFTER' },
    ]);
  });

  test('every function that pins a search_path ends it with pg_temp', async () => {
    const rows = await engine.executeRaw<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting)
         WHERE n.nspname = 'public' AND s.setting LIKE 'search_path=%' AND s.setting NOT LIKE '%, pg_temp' ORDER BY 1`);
    expect(rows.map(r => r.sig)).toEqual([]);
  });

  test('an AFTER ROW guard still refuses purged page content and leaves no row', async () => {
    await engine.executeRaw(`INSERT INTO page_purges (source_id, content_hash, slug) VALUES ('default', 'deadbeefcafe00000000000000000002', 'notes/purged-example')`);
    await expect(engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash)
      VALUES ('notes/again-example', 'note', 't', 'x', 'deadbeefcafe00000000000000000002')`)).rejects.toThrow('purged_content: this page content was purged');
    expect(await engine.executeRaw(`SELECT 1 FROM pages WHERE slug = 'notes/again-example'`)).toEqual([]);
  });
});
