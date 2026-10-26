/**
 * guard_functions doctor check (#7632): guardFunctionProblems names each guard drift with SQL that clears it. The
 * Postgres non-owner path is in test/e2e/guard-definer-postgres.test.ts (case 11).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { guardFunctionProblems } from '../src/commands/doctor/checks/guard-functions.ts';

describe('guard_functions doctor check (#7632)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a fresh install has no problem', async () => {
    expect(await guardFunctionProblems(engine)).toEqual({ problems: [], fix: [] });
  });

  test('each drift is named, and running the printed fix clears every one', async () => {
    await engine.runMigration(0, `ALTER FUNCTION gbrain_refuse_purged_page() SECURITY INVOKER SET search_path = pg_catalog, public;
      GRANT EXECUTE ON FUNCTION gbrain_refuse_purged_take() TO PUBLIC;
      DROP TRIGGER pages_refuse_purged ON pages;
      CREATE TRIGGER pages_refuse_purged BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_page();
      DROP TRIGGER page_segment_derivations_refuse_purging ON page_segment_derivations;
      CREATE TRIGGER page_segment_derivations_refuse_purging BEFORE INSERT OR UPDATE OF output, receipt ON page_segment_derivations
        FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purging_derivation();
      ALTER FUNCTION gbrain_try_jsonb(text) SET search_path = pg_catalog, public;`);
    const { problems, fix } = await guardFunctionProblems(engine);
    expect(problems).toEqual([
      'gbrain_refuse_purged_page() is not SECURITY DEFINER with search_path pg_catalog, public, pg_temp',
      'gbrain_refuse_purged_take() is executable by PUBLIC',
      'pages_refuse_purged on pages still fires BEFORE ROW',
      'page_segment_derivations_refuse_purging has no gbrain_caller_sees_page gate',
      '2 function(s) pin search_path without pg_temp last (gbrain_refuse_purged_page(), gbrain_try_jsonb(text))',
    ]);
    await engine.runMigration(0, fix.join('\n'));
    expect(await guardFunctionProblems(engine)).toEqual({ problems: [], fix: [] });
  });
});
