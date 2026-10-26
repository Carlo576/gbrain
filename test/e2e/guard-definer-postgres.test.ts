/**
 * The purge and withdrawal guards hold under a scoped write role, and running them as their owner opens nothing
 * (#7632, src/core/guard-definer.ts). Real Postgres: a role that may write every gbrain table except the purge and
 * withdrawal ledgers (NOLOGIN, NOBYPASSRLS, not the owner), and Supabase-style `anon`/`authenticated` roles that
 * hold the default table and function grants and no policy.
 *
 * Before #7632 the guards were SECURITY INVOKER: under that role a ledger read returned no row, so a purged claim,
 * page, take or derivation was stored again and a withdrawn fact was saved active. Cases 6-9 pin the holes a definer
 * could open: a temp table or view named like a ledger (the caller's temp schema is searched first unless pg_temp is
 * named last), a BEFORE ROW definer answering a role RLS refuses (case 17: a role that can read the page but whose
 * derivation row RLS refuses), and direct calls.
 * Run: DATABASE_URL=... bun test test/e2e/guard-definer-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, runMigrations } from '../../src/core/migrate.ts';
import { guardFunctionProblems } from '../../src/commands/doctor/checks/guard-functions.ts';
import { derivationNeedles } from '../../src/core/page-body/segment-derive.ts';
import { DerivationWriteRefused } from '../../src/core/page-body/derivations.ts';
import { MEMORY_PURGE_GUARD_SQL } from '../../src/core/facts/purge-schema.ts';
import { FACT_INSERT_GUARD_SQL } from '../../src/core/facts/insert-guard-schema.ts';
import { v276 } from '../../src/core/schema-migrations/v276-guard-triggers-security-definer.ts';
import { withEnv } from '../helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;
type Outcome = { rows: Array<Record<string, unknown>> } | { code: string; message: string };

const GUARDS = ['gbrain_mark_derivation_scope_entry', 'gbrain_refuse_purged_fact', 'gbrain_refuse_purged_page', 'gbrain_refuse_purged_take',
  'gbrain_refuse_revived_withdrawn_fact', 'gbrain_refuse_stored_purging_derivation', 'gbrain_refuse_unguarded_inserted_facts'];
/** The definer guards #7632 adds; the rest existed before as invokers. */
const NEW_GUARDS = ['gbrain_refuse_revived_withdrawn_fact', 'gbrain_refuse_stored_purging_derivation', 'gbrain_refuse_unguarded_inserted_facts'];
const GUARD_TRIGGER_NAMES = ['facts_refuse_purged', 'facts_refuse_revived_withdrawal', 'facts_refuse_unguarded_inserted', 'pages_refuse_purged',
  'page_segment_derivations_refuse_stored_purging', 'takes_refuse_purged'];
const DEFINER_PATH = ['search_path=pg_catalog, pg_temp'];
const LEDGERS = ['fact_purges', 'fact_withdrawals', 'take_purges', 'page_purges', 'page_segment_derivation_purges', 'page_segment_derivation_purge_pages'];
const API_ROLES = ['anon', 'authenticated'];

const PURGED_CLAIM = 'alice-example joined acme-example as cto';
const WITHDRAWN_CLAIM = 'alice-example lives in city-a';
const PURGED_TAKE = 'acme-example will double revenue';
const PURGED_HASH = 'deadbeefcafe00000000000000000001';
const SHA = `decode(repeat('ab', 32), 'hex')`;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const WRITER = `gbrain_test_guard_writer_${suffix}`;
const scratch: string[] = [];
const createdRoles: string[] = [];
let admin: Sql | null = null;

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A freshly initialized brain whose public schema grants anon and authenticated what Supabase's default privileges do. */
async function supabaseShapedBrain(): Promise<{ url: string; conn: Sql }> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_guard_${randomUUID().replaceAll('-', '')}`;
  await admin!.unsafe(`CREATE DATABASE ${name}`);
  scratch.push(name);
  const url = urlFor(name);
  const conn = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  await conn.unsafe(`GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated`);
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  try { await engine.initSchema(); } finally { await engine.disconnect(); }
  return { url, conn };
}

/** Runs `fn` as `role` in one transaction that is rolled back; each `run` is its own savepoint. */
async function as<T>(conn: Sql, role: string, fn: (run: (sql: string, params?: unknown[]) => Promise<Outcome>) => Promise<T>): Promise<T> {
  const session = await conn.reserve();
  try {
    await session.unsafe('BEGIN');
    await session.unsafe(`SET LOCAL ROLE ${role}`);
    return await fn(async (sql, params) => {
      await session.unsafe('SAVEPOINT attempt');
      try {
        const rows = await session.unsafe(sql, params as never[]);
        await session.unsafe('RELEASE SAVEPOINT attempt');
        return { rows: [...rows] as Array<Record<string, unknown>> };
      } catch (error) {
        await session.unsafe('ROLLBACK TO SAVEPOINT attempt');
        const e = error as { code?: string; message?: string };
        return { code: String(e.code), message: String(e.message) };
      }
    });
  } finally {
    await session.unsafe('ROLLBACK').catch(() => {});
    session.release();
  }
}

const rowsOf = (o: Outcome) => ('rows' in o ? o.rows : (() => { throw new Error(`expected rows, got ${o.code}: ${o.message}`); })());
const failure = (o: Outcome) => ('code' in o ? { code: o.code, message: o.message } : { code: 'none', message: `stored ${o.rows.length} row(s)` });

describeE2E('purge and withdrawal guards under a scoped write role (#7632)', () => {
  let conn: Sql;
  let url: string;
  const ids: Record<string, number> = {};
  let withdrawnAt = '';
  const request = randomUUID();

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    for (const role of API_ROLES) {
      if ((await admin.unsafe('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).length > 0) continue;
      await admin.unsafe(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
      createdRoles.push(role);
    }
    await admin.unsafe(`CREATE ROLE ${WRITER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    createdRoles.push(WRITER);
    ({ url, conn } = await supabaseShapedBrain());
    // The writer may read and write every gbrain table except the ledgers: the configuration the guards failed open under.
    await conn.unsafe(`GRANT USAGE ON SCHEMA public TO ${WRITER};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${WRITER};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${WRITER};
      DO $$ DECLARE t RECORD; BEGIN
        FOR t IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relname = ANY(ARRAY['${LEDGERS.join("','")}']) LOOP
          EXECUTE format('CREATE POLICY gbrain_test_writer ON %s TO ${WRITER} USING (true) WITH CHECK (true)', t.rel);
        END LOOP; END $$`);
    expect((await conn.unsafe(`SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity ORDER BY 1`, [LEDGERS])).length).toBe(LEDGERS.length);

    for (const [key, slug] of [['takes', 'people/alice-example'], ['derived', 'notes/derivation-example'], ['deleted', 'notes/soon-deleted-example']]) {
      const [row] = await conn.unsafe<Array<{ id: number }>>(`INSERT INTO pages (slug, type, title, compiled_truth) VALUES ($1, 'note', $1, 'x') RETURNING id`, [slug]);
      ids[key] = row!.id;
    }
    await conn.unsafe(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint($1))`, [PURGED_CLAIM]);
    const [w] = await conn.unsafe<Array<{ at: string }>>(
      `INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint($1)) RETURNING withdrawn_at::text AS at`, [WITHDRAWN_CLAIM]);
    withdrawnAt = w!.at;
    await conn.unsafe(`INSERT INTO page_purges (source_id, content_hash, slug) VALUES ('default', $1, 'notes/purged-example')`, [PURGED_HASH]);
    await conn.unsafe(`INSERT INTO take_purges (source_id, subject, claim_hash) VALUES ('default', '*', gbrain_fact_fingerprint($1))`, [PURGED_TAKE]);
    const { needles, patterns } = await derivationNeedles({ executeRaw: (sql: string, params?: unknown[]) => conn.unsafe(sql, params as never[]) } as never, [PURGED_CLAIM]);
    await conn.unsafe(`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns, page_ids) VALUES ($1::uuid, 'default', $2::text[], $3::text[], $4::int[])`,
      [request, needles, patterns, [ids.derived]]);
  }, 300_000);

  afterAll(async () => {
    await conn?.end();
    if (admin) {
      for (const name of scratch) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const role of createdRoles) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.end();
    }
  });

  const insertDerivation = (output: string) => [`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output)
    VALUES ($1, 'links', $2, 1, ${SHA}, ${SHA}, 'done', $3::jsonb) RETURNING 1 AS stored`, output] as const;

  test('1. a purged claim is refused: a multi-row insert and an update into it', async () => {
    await as(conn, WRITER, async run => {
      expect(failure(await run(`INSERT INTO facts (fact, source) VALUES ('an unrelated claim', 'probe'), ($1, 'probe')`, [PURGED_CLAIM])))
        .toEqual({ code: 'P0001', message: expect.stringContaining('purged_content: this claim was purged') });
      const [row] = rowsOf(await run(`INSERT INTO facts (fact, source) VALUES ('an unrelated claim', 'probe') RETURNING id`));
      expect(failure(await run('UPDATE facts SET fact = $1 WHERE id = $2', [PURGED_CLAIM, row!.id])))
        .toEqual({ code: 'P0001', message: expect.stringContaining('purged_content: this claim was purged') });
    });
  });

  test('2. a withdrawn claim stays withdrawn: an owner is stamped as before; a writer that cannot read the withdrawals is refused on a row insert, a deferred insert and an update clearing expired_at', async () => {
    await as(conn, WRITER, async run => {
      expect(failure(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [WITHDRAWN_CLAIM])))
        .toMatchObject({ code: 'P0001', message: expect.stringContaining('fact_withdrawn:') });
      rowsOf(await run(`SET LOCAL gbrain.fact_withdrawal_stamp_deferred = 'on'`));
      expect(failure(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe-deferred')`, [WITHDRAWN_CLAIM])))
        .toMatchObject({ code: 'P0001', message: expect.stringContaining('fact_withdrawn:') });
      rowsOf(await run('RESET ROLE'));
      const [deferred] = rowsOf(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe-deferred') RETURNING id`, [WITHDRAWN_CLAIM]));
      rowsOf(await run(`SET LOCAL gbrain.fact_withdrawal_stamp_deferred = 'off'`));
      expect(rowsOf(await run('SELECT expired_at::text AS at FROM facts WHERE id = $1', [deferred!.id]))).toEqual([{ at: withdrawnAt }]);
      rowsOf(await run('UPDATE facts SET expired_at = NULL, valid_until = NULL WHERE id = $1', [deferred!.id]));
      expect(rowsOf(await run('SELECT expired_at::text AS at FROM facts WHERE id = $1', [deferred!.id]))).toEqual([{ at: withdrawnAt }]);
      rowsOf(await run(`SET LOCAL ROLE ${WRITER}`));
      expect(failure(await run('UPDATE facts SET expired_at = NULL, valid_until = NULL WHERE id = $1', [deferred!.id])))
        .toMatchObject({ code: 'P0001', message: expect.stringContaining('fact_withdrawn:') });
      expect(rowsOf(await run('SELECT expired_at::text AS at FROM facts WHERE id = $1', [deferred!.id]))).toEqual([{ at: withdrawnAt }]);
    });
  });

  test('3. purged page content and a purged take claim are refused', async () => {
    await as(conn, WRITER, async run => {
      expect(failure(await run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1)`, [PURGED_HASH])))
        .toEqual({ code: 'P0001', message: expect.stringContaining('purged_content: this page content was purged') });
      expect(failure(await run('UPDATE pages SET content_hash = $1 WHERE id = $2', [PURGED_HASH, ids.takes])))
        .toEqual({ code: 'P0001', message: expect.stringContaining('purged_content: this page content was purged') });
      expect(failure(await run(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, $2, 'take', 'alice-example')`, [ids.takes, PURGED_TAKE])))
        .toEqual({ code: 'P0001', message: expect.stringContaining('purged_content: this take claim was purged') });
    });
  });

  test('4. a derivation holding a purged claim during its sweep is refused for a writer that cannot read the sweep; an unrelated one is stored', async () => {
    await as(conn, WRITER, async run => {
      const [held, heldOutput] = insertDerivation(JSON.stringify({ text: PURGED_CLAIM }));
      expect(failure(await run(held, [ids.derived, 1, heldOutput]))).toMatchObject({ code: 'P0001', message: expect.stringContaining('derivation_purge_pending:') });
      const [other, otherOutput] = insertDerivation(JSON.stringify({ text: 'an unrelated link context' }));
      expect(rowsOf(await run(other, [ids.derived, 2, otherOutput]))).toEqual([{ stored: 1 }]);
      // Generated by gstack /ship coverage audit (#7642).
      // Value: protects=the AFTER ROW stored check refuses an UPDATE that rewrites a stored derivation into a purged claim
      // during its sweep; fails_when=the stored trigger stops firing on UPDATE OF output, receipt (INSERT only);
      // why_new=case 4 inserted only, and the catalog goldens are regenerated with each schema change; seam=none;
      // no_claim=an UPDATE of receipt alone (same trigger column list, not exercised)
      expect(failure(await run('UPDATE page_segment_derivations SET output = $1::jsonb WHERE page_id = $2 AND occurrence_id = 2', [heldOutput, ids.derived])))
        .toMatchObject({ code: 'P0001', message: expect.stringContaining('derivation_purge_pending:') });
    });
  });

  test('5. a page soft-deleted during a derivation sweep is noted for the sweep', async () => {
    await as(conn, WRITER, async run => {
      rowsOf(await run('UPDATE pages SET deleted_at = now() WHERE id = $1', [ids.deleted]));
      rowsOf(await run('RESET ROLE'));
      expect(rowsOf(await run('SELECT page_id FROM page_segment_derivation_purge_pages WHERE request_id = $1::uuid', [request])))
        .toEqual([{ page_id: ids.deleted }]);
    });
  });

  test('6. temp tables named like the ledgers do not hide them', async () => {
    await as(conn, WRITER, async run => {
      for (const ledger of LEDGERS) rowsOf(await run(`CREATE TEMP TABLE ${ledger} (LIKE public.${ledger})`));
      expect(failure(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [PURGED_CLAIM])).code).toBe('P0001');
      expect(failure(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [WITHDRAWN_CLAIM]))).toMatchObject({ code: 'P0001', message: expect.stringContaining('fact_withdrawn:') });
      expect(failure(await run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1)`, [PURGED_HASH])).code).toBe('P0001');
      expect(failure(await run(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, $2, 'take', 'alice-example')`, [ids.takes, PURGED_TAKE])).code).toBe('P0001');
      const [held, heldOutput] = insertDerivation(JSON.stringify({ text: PURGED_CLAIM }));
      expect(failure(await run(held, [ids.derived, 1, heldOutput])).code).toBe('P0001');
    });
  });

  test('7. a temp view named like a ledger never runs the caller\'s code (as the owner or at all)', async () => {
    await as(conn, WRITER, async run => {
      rowsOf(await run('CREATE TEMP TABLE witness (who text)'));
      for (const ledger of ['page_purges', 'fact_purges']) {
        rowsOf(await run(`CREATE FUNCTION pg_temp.spy_${ledger}() RETURNS SETOF public.${ledger} LANGUAGE plpgsql AS $f$
          BEGIN INSERT INTO pg_temp.witness VALUES (current_user); RETURN; END $f$`));
        rowsOf(await run(`CREATE TEMP VIEW ${ledger} AS SELECT * FROM pg_temp.spy_${ledger}()`));
      }
      const purgedPage = failure(await run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1)`, [PURGED_HASH]));
      const purgedFact = failure(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [PURGED_CLAIM]));
      rowsOf(await run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/fine-example', 'note', 't', 'x', 'feedface')`));
      rowsOf(await run(`INSERT INTO facts (fact, source) VALUES ('an unrelated claim', 'probe')`));
      expect(rowsOf(await run('SELECT DISTINCT who FROM pg_temp.witness'))).toEqual([]);
      expect([purgedPage.code, purgedFact.code]).toEqual(['P0001', 'P0001']);
    });
  });

  test('8. a role RLS refuses gets the same error for purged and unpurged content (no existence oracle)', async () => {
    for (const role of API_ROLES) {
      await as(conn, role, async run => {
        const page = (hash: string) => run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/probe-example', 'note', 't', 'x', $1)`, [hash]);
        expect(failure(await page(PURGED_HASH))).toEqual(failure(await page('feedface00000000')));
        expect(failure(await page(PURGED_HASH)).code).toBe('42501');
        const take = (claim: string) => run(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, $2, 'take', 'alice-example')`, [ids.takes, claim]);
        expect(failure(await take(PURGED_TAKE))).toEqual(failure(await take('an unrelated take')));
        const fact = (claim: string) => run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [claim]);
        expect(failure(await fact(PURGED_CLAIM))).toEqual(failure(await fact('an unrelated claim')));
        const [sql] = insertDerivation('{}');
        const derivation = (text: string) => run(sql, [ids.derived, 9, JSON.stringify({ text })]);
        expect(failure(await derivation(PURGED_CLAIM))).toEqual(failure(await derivation('an unrelated link context')));
        expect(failure(await derivation(PURGED_CLAIM)).code).toBe('42501');
      });
    }
  });

  test('9. no guard can be called directly', async () => {
    for (const role of [WRITER, ...API_ROLES]) {
      await as(conn, role, async run => {
        for (const fn of GUARDS) expect({ fn, ...failure(await run(`SELECT ${fn}()`)) }).toMatchObject({ fn, code: '42501' });
      });
    }
  });

  /** The definer posture of the guards and the search_path of every function that pins one. */
  async function catalog(c: Sql) {
    const guards = await c.unsafe<Array<{ fn: string; secdef: boolean; config: string[] | null; executable_by: string[] }>>(
      `SELECT p.proname AS fn, p.prosecdef AS secdef, p.proconfig AS config,
         ARRAY(SELECT 'PUBLIC' WHERE EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
               UNION ALL SELECT r.rolname::text FROM pg_roles r WHERE r.rolname = ANY($2::text[]) AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS executable_by
         FROM pg_proc p WHERE p.oid = ANY(SELECT to_regprocedure(g || '()') FROM unnest($1::text[]) g) ORDER BY 1`, [GUARDS, API_ROLES]);
    const triggers = await c.unsafe<Array<{ trigger: string; timing: string }>>(
      `SELECT tgname AS trigger, CASE WHEN (tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing FROM pg_trigger WHERE NOT tgisinternal
         AND tgname = ANY($1::text[]) ORDER BY 1`, [[...GUARD_TRIGGER_NAMES, 'page_segment_derivations_refuse_purging']]);
    const definers = await c.unsafe<Array<{ fn: string; config: string[] | null }>>(
      `SELECT p.proname AS fn, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`);
    const pathsWithoutTemp = await c.unsafe<Array<{ sig: string }>>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting)
         WHERE n.nspname = 'public' AND s.setting LIKE 'search_path=%' AND s.setting NOT LIKE '%, pg_temp' ORDER BY 1`);
    return {
      guards: guards.map(g => ({ fn: g.fn, secdef: g.secdef, config: g.config, executable_by: g.executable_by })),
      triggers: triggers.map(t => ({ trigger: t.trigger, timing: t.timing })),
      pathsWithoutTemp: pathsWithoutTemp.map(p => p.sig),
      definers: definers.map(d => ({ fn: d.fn, config: d.config })),
    };
  }

  const EXPECTED = {
    guards: GUARDS.map(fn => ({ fn, secdef: true, config: DEFINER_PATH, executable_by: [] })),
    triggers: [
      { trigger: 'facts_refuse_purged', timing: 'AFTER' },
      { trigger: 'facts_refuse_revived_withdrawal', timing: 'AFTER' },
      { trigger: 'facts_refuse_unguarded_inserted', timing: 'AFTER' },
      { trigger: 'page_segment_derivations_refuse_purging', timing: 'BEFORE' },
      { trigger: 'page_segment_derivations_refuse_stored_purging', timing: 'AFTER' },
      { trigger: 'pages_refuse_purged', timing: 'AFTER' },
      { trigger: 'takes_refuse_purged', timing: 'AFTER' },
    ],
    pathsWithoutTemp: [],
    // Every SECURITY DEFINER function in public is one of the guards, with public off its path: a redefinition that
    // puts public back, or a new definer, fails here.
    definers: GUARDS.map(fn => ({ fn, config: DEFINER_PATH })),
  };

  test('10a. after a fresh install: guards are definers pinned to pg_catalog, pg_temp (the only definers in public), not executable by PUBLIC/anon/authenticated, raising triggers AFTER ROW, every pinned search_path ends in pg_temp', async () => {
    expect(await catalog(conn)).toEqual(EXPECTED);
  });

  /** Puts a brain back in the shape every brain had before #7632, at the version before it. */
  /** Puts a brain back in the shape every brain had before #7632, at the version before it. */
  async function rewind(c: Sql): Promise<void> {
    await c.unsafe(`
      ${MEMORY_PURGE_GUARD_SQL}
      ${FACT_INSERT_GUARD_SQL}
      GRANT EXECUTE ON FUNCTION gbrain_refuse_purged_fact(), gbrain_refuse_purged_take(), gbrain_refuse_purged_page() TO PUBLIC, anon, authenticated;
      DROP TRIGGER facts_refuse_revived_withdrawal ON facts;
      DROP FUNCTION gbrain_refuse_revived_withdrawn_fact();
      DROP TRIGGER facts_refuse_unguarded_inserted ON facts;
      DROP FUNCTION gbrain_refuse_unguarded_inserted_facts();
      DROP TRIGGER page_segment_derivations_refuse_stored_purging ON page_segment_derivations;
      DROP FUNCTION gbrain_refuse_stored_purging_derivation();
      ALTER FUNCTION gbrain_mark_derivation_scope_entry() SECURITY INVOKER SET search_path = pg_catalog, public;
      GRANT EXECUTE ON FUNCTION gbrain_mark_derivation_scope_entry() TO PUBLIC, anon, authenticated;
      DO $$ DECLARE f RECORD; BEGIN
        FOR f IN SELECT p.oid::regprocedure AS sig, substr(s.setting, 13) AS path FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  CROSS JOIN LATERAL unnest(p.proconfig) AS s(setting) WHERE n.nspname = 'public' AND s.setting LIKE 'search_path=%, pg_temp' LOOP
          EXECUTE format('ALTER FUNCTION %s SET search_path = %s', f.sig, left(f.path, -9));
        END LOOP; END $$;
      UPDATE config SET value = '${LATEST_VERSION - 1}' WHERE key = 'version';`);
  }

  async function capturingStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
    const write = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try { return { value: await fn(), stderr }; } finally { process.stderr.write = write; }
  }

  test('10b. a brain at the version before, migrated (no schema blob replay), ends the same, and doctor passes only after', async () => {
    const brain = await supabaseShapedBrain();
    const engine = new PostgresEngine();
    try {
      await rewind(brain.conn);
      expect((await catalog(brain.conn)).pathsWithoutTemp.length).toBeGreaterThan(30);
      await engine.connect({ database_url: brain.url });
      expect((await guardFunctionProblems(engine)).problems.length).toBeGreaterThan(0);
      const { value, stderr } = await capturingStderr(() => runMigrations(engine));
      expect(value.current).toBe(LATEST_VERSION);
      expect(stderr).not.toContain('left as they were');
      expect(await catalog(brain.conn)).toEqual(EXPECTED);
      expect(await guardFunctionProblems(engine)).toEqual({ problems: [], fix: [] });
    } finally {
      await engine.disconnect();
      await brain.conn.end();
    }
  }, 300_000);

  test('11. a migrating role that owns nothing names what it left and carries on; doctor fails with SQL that fixes it', async () => {
    const brain = await supabaseShapedBrain();
    const migrator = `gbrain_test_guard_migrator_${suffix}`;
    await admin!.unsafe(`CREATE ROLE ${migrator} LOGIN PASSWORD 'migrator' NOSUPERUSER BYPASSRLS`);
    createdRoles.push(migrator);
    const owner = new PostgresEngine();
    const notOwner = new PostgresEngine();
    try {
      await rewind(brain.conn);
      await brain.conn.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrator}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${migrator}`);
      const asMigrator = new URL(brain.url);
      asMigrator.username = migrator;
      asMigrator.password = 'migrator';
      await notOwner.connect({ database_url: asMigrator.toString() });
      const { value, stderr } = await capturingStderr(() => runMigrations(notOwner));
      expect(value.current).toBe(LATEST_VERSION);
      for (const fn of GUARDS) expect(stderr).toContain(`${fn}()`);
      for (const trigger of GUARD_TRIGGER_NAMES) expect(stderr).toContain(trigger);
      expect(stderr).toContain('left as they were');
      // Generated by gstack /ship coverage audit (#7642).
      // Value: protects=v276 names on stderr every non-guard function whose search_path it could not finish with pg_temp;
      // fails_when=the unhardened-function listing is dropped from hardenGuards; why_new=the guard names above also come
      // from the function loop; seam=none; no_claim=none beyond protects
      expect(stderr).toContain('gbrain_try_jsonb(text)');
      expect((await catalog(brain.conn)).guards.every(g => !g.secdef)).toBe(true);
      await notOwner.disconnect();

      await owner.connect({ database_url: brain.url });
      const { problems, fix } = await guardFunctionProblems(owner);
      expect(problems.length).toBeGreaterThan(0);
      await owner.executeRaw(fix.join('\n'));
      expect(await guardFunctionProblems(owner)).toEqual({ problems: [], fix: [] });
      expect(await catalog(brain.conn)).toEqual(EXPECTED);
    } finally {
      await notOwner.disconnect().catch(() => {});
      await owner.disconnect().catch(() => {});
      await brain.conn.end();
    }
  }, 300_000);

  // Generated by gstack /ship coverage audit (#7642).
  // Value: protects=a brain already at the latest version that boots again (schema blob replay, no migration runs) keeps
  // the definer guards, trigger placement and pg_temp on every pinned path; fails_when=the hardening fragment stops being
  // the blob's last statement or a blob CREATE OR REPLACE drops SECURITY DEFINER; why_new=10a/10b run v276, which
  // re-hardens everything; seam=none; no_claim=PGLite replay (pglite-upgrade-replay golden covers it)
  test('12. a brain at the latest version that boots again (schema blob replay, no migration) keeps the catalog, and doctor passes', async () => {
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: url });
      const { value } = await capturingStderr(() => runMigrations(engine));
      expect(value.applied).toBe(0);
      await engine.initSchema();
      expect(await catalog(conn)).toEqual(EXPECTED);
      expect(await guardFunctionProblems(engine)).toEqual({ problems: [], fix: [] });
    } finally {
      await engine.disconnect();
    }
  }, 300_000);

  // Generated by gstack /ship coverage audit (#7642).
  // Value: protects=doctor names a guard whose owner neither bypasses RLS nor owns its ledger, a guard that really lets
  // purged content through; fails_when=the reads_under_rls probe is dropped or its owner/force condition inverted;
  // why_new=every other case runs the guards as a superuser owner; seam=none; no_claim=FORCE ROW LEVEL SECURITY on an
  // owner-owned ledger (same branch, not exercised)
  test('13. doctor names a guard whose owner reads its ledger under RLS, and that guard does let purged content through', async () => {
    const weakOwner = `gbrain_test_guard_owner_${suffix}`;
    await admin!.unsafe(`CREATE ROLE ${weakOwner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    createdRoles.push(weakOwner);
    const [fn] = await conn.unsafe<Array<{ owner: string }>>(`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'gbrain_refuse_purged_page()'::regprocedure`);
    const owner = fn!.owner;
    const insertPurgedPage = `INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1) RETURNING 1 AS stored`;
    const engine = new PostgresEngine();
    try {
      await conn.unsafe(`GRANT USAGE ON SCHEMA public TO ${weakOwner}; GRANT SELECT ON page_purges TO ${weakOwner};
        ALTER FUNCTION gbrain_refuse_purged_page() OWNER TO ${weakOwner}`);
      await engine.connect({ database_url: url });
      expect(await guardFunctionProblems(engine)).toEqual({
        problems: [`gbrain_refuse_purged_page()'s owner ${weakOwner} neither bypasses RLS nor owns page_purges unforced, so the guard reads them filtered`],
        fix: ['/* give gbrain_refuse_purged_page() an owner that bypasses RLS and is not the role gbrain runs as, so that role stays under its policies: ALTER FUNCTION gbrain_refuse_purged_page() OWNER TO <that role>; */'],
      });
      await as(conn, WRITER, async run => {
        expect(rowsOf(await run(insertPurgedPage, [PURGED_HASH]))).toEqual([{ stored: 1 }]);
      });
    } finally {
      await conn.unsafe(`ALTER FUNCTION gbrain_refuse_purged_page() OWNER TO ${owner}; REVOKE ALL ON page_purges FROM ${weakOwner}; REVOKE USAGE ON SCHEMA public FROM ${weakOwner}`);
      await engine.disconnect();
    }
    await as(conn, WRITER, async run => {
      expect(failure(await run(insertPurgedPage, [PURGED_HASH])).code).toBe('P0001');
    });
  });

  // Generated by gstack /ship coverage audit (#7642).
  // Value: protects=v276 stops with the typed schema_lock_blocked refusal naming the table when another session holds a
  // lock, leaves that trigger as it was, and finishes once the lock is gone; fails_when=SET LOCAL lock_timeout or the
  // 55P03 mapping is dropped (upgrade hangs or throws untyped); why_new=no test holds a lock against v276; seam=none;
  // no_claim=the blocking-session sample (v276 passes sessions: null) and transaction-pooler behavior
  test('14. v276 refuses with schema_lock_blocked when another session holds a lock on a table whose trigger it moves, and finishes after', async () => {
    const engine = new PostgresEngine();
    const holder = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    const factsTiming = async () => (await catalog(conn)).triggers.find(t => t.trigger === 'facts_refuse_purged')?.timing;
    try {
      await conn.unsafe(`DROP TRIGGER facts_refuse_purged ON facts;
        CREATE TRIGGER facts_refuse_purged BEFORE UPDATE OF fact, source_id, visibility, entity_slug ON facts FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_fact()`);
      await engine.connect({ database_url: url });
      const session = await holder.reserve();
      try {
        await session.unsafe('BEGIN; LOCK TABLE facts IN ACCESS SHARE MODE');
        const error = await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => v276.handler!(engine).then(() => null, (e: unknown) => e));
        expect(error).toMatchObject({ code: 'schema_lock_blocked', detail: 'v276 on facts' });
        expect(await factsTiming()).toBe('BEFORE');
      } finally {
        await session.unsafe('ROLLBACK');
        session.release();
      }
      await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => v276.handler!(engine));
      expect(await catalog(conn)).toEqual(EXPECTED);
    } finally {
      await holder.end();
      await engine.disconnect();
    }
  }, 300_000);

  test('15. a migrating role that owns the guards but not their tables leaves each raising guard an invoker while its trigger fires BEFORE ROW', async () => {
    const brain = await supabaseShapedBrain();
    const migrator = `gbrain_test_guard_fn_owner_${suffix}`;
    await admin!.unsafe(`CREATE ROLE ${migrator} LOGIN PASSWORD 'migrator' NOSUPERUSER BYPASSRLS`);
    createdRoles.push(migrator);
    const engine = new PostgresEngine();
    const exposed = ['gbrain_refuse_purged_fact', 'gbrain_refuse_purged_page', 'gbrain_refuse_purged_take'];
    try {
      await rewind(brain.conn);
      await brain.conn.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrator}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${migrator};
        ${GUARDS.filter(fn => !NEW_GUARDS.includes(fn)).map(fn => `ALTER FUNCTION ${fn}() OWNER TO ${migrator};`).join('\n')}`);
      const asMigrator = new URL(brain.url);
      asMigrator.username = migrator;
      asMigrator.password = 'migrator';
      await engine.connect({ database_url: asMigrator.toString() });
      const { value, stderr } = await capturingStderr(() => runMigrations(engine));
      expect(value.current).toBe(LATEST_VERSION);
      for (const fn of [...exposed, ...NEW_GUARDS]) expect(stderr).toContain(`${fn}()`);
      const after = await catalog(brain.conn);
      expect(after.guards.map(g => [g.fn, g.secdef])).toEqual(GUARDS.filter(fn => !NEW_GUARDS.includes(fn)).map(fn => [fn, !exposed.includes(fn)]));
      expect(after.triggers.map(t => [t.trigger, t.timing])).toEqual([
        ['facts_refuse_purged', 'BEFORE'], ['page_segment_derivations_refuse_purging', 'BEFORE'], ['pages_refuse_purged', 'BEFORE'], ['takes_refuse_purged', 'BEFORE'],
      ]);
    } finally {
      await engine.disconnect().catch(() => {});
      await brain.conn.end();
    }
  }, 300_000);

  test('16. owners, roles that bypass RLS and writers with policies on the ledgers still have a derivation dropped and a withdrawn fact stamped silently', async () => {
    const bypass = `gbrain_test_guard_bypass_${suffix}`;
    const reader = `gbrain_test_guard_reader_${suffix}`;
    await admin!.unsafe(`CREATE ROLE ${bypass} NOLOGIN NOSUPERUSER BYPASSRLS; CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    createdRoles.push(bypass, reader);
    await conn.unsafe(`GRANT USAGE ON SCHEMA public TO ${bypass}, ${reader};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${bypass}, ${reader};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${bypass}, ${reader};
      DO $$ DECLARE t RECORD; BEGIN
        FOR t IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity LOOP
          EXECUTE format('CREATE POLICY gbrain_test_reader ON %s TO ${reader} USING (true) WITH CHECK (true)', t.rel);
        END LOOP; END $$`);
    const [held, heldOutput] = insertDerivation(JSON.stringify({ text: PURGED_CLAIM }));
    const [{ owner }] = await conn.unsafe<Array<{ owner: string }>>('SELECT current_user AS owner');
    for (const role of [owner!, bypass, reader]) {
      await as(conn, role, async run => {
        expect({ role, rows: rowsOf(await run(held, [ids.derived, 1, heldOutput])) }).toEqual({ role, rows: [] });
        expect({ role, rows: rowsOf(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe') RETURNING expired_at::text AS at`, [WITHDRAWN_CLAIM])) })
          .toEqual({ role, rows: [{ at: withdrawnAt }] });
      });
    }
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: url });
      const row = (occurrenceId: number, text: string) => ({ pageId: ids.derived!, kind: 'links' as const, occurrenceId, version: 1,
        segmentSha256: new Uint8Array(32).fill(0xab), contextHash: new Uint8Array(32).fill(0xab), state: 'done' as const, output: { text }, receipt: null });
      const refused = await engine.upsertSegmentDerivations([row(31, PURGED_CLAIM), row(32, 'an unrelated link context')]).then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(DerivationWriteRefused);
      expect((refused as DerivationWriteRefused).refused).toBe(1);
      expect((await conn.unsafe('SELECT occurrence_id::int AS o FROM page_segment_derivations WHERE page_id = $1 AND occurrence_id IN (31, 32) ORDER BY 1', [ids.derived]))
        .map(r => r.o)).toEqual([32]);
    } finally {
      await conn.unsafe('DELETE FROM page_segment_derivations WHERE page_id = $1 AND occurrence_id IN (31, 32)', [ids.derived]);
      await engine.disconnect();
    }
  });

  test('17. a role that can read the page but whose derivation row RLS refuses gets the same 42501 for a purged claim and unrelated text', async () => {
    await conn.unsafe('CREATE POLICY gbrain_test_read_pages ON pages FOR SELECT TO authenticated USING (true)');
    try {
      await as(conn, 'authenticated', async run => {
        expect(rowsOf(await run('SELECT id FROM pages WHERE id = $1', [ids.derived]))).toEqual([{ id: ids.derived }]);
        const [sql] = insertDerivation('{}');
        const derivation = (text: string) => run(sql, [ids.derived, 9, JSON.stringify({ text })]);
        const purged = failure(await derivation(PURGED_CLAIM));
        expect(purged).toEqual(failure(await derivation('an unrelated link context')));
        expect(purged.code).toBe('42501');
      });
    } finally {
      await conn.unsafe('DROP POLICY gbrain_test_read_pages ON pages');
    }
  });

  // A writer with CREATE on public (Supabase grants it to anon and authenticated) plants overloads of what the definer
  // bodies call; each spy raises when it runs as anyone but the writer, so a definer that resolved it shows in the error.
  test('18. overloads planted in public never run as the owner: hashtextextended, json_build_object, jsonb_path_query, gbrain_fact_fingerprint', async () => {
    const spy = (signature: string, returns: string, call: string) => `CREATE FUNCTION public.${signature} RETURNS ${returns} LANGUAGE plpgsql AS $f$
      BEGIN IF current_user <> '${WRITER}' THEN RAISE EXCEPTION 'spy % ran as %', '${signature.split('(')[0]}', current_user; END IF; ${call} END $f$`;
    await conn.unsafe(`GRANT CREATE ON SCHEMA public TO ${WRITER}`);
    try {
      await as(conn, WRITER, async run => {
        rowsOf(await run(spy('hashtextextended(a text, b integer)', 'bigint', 'RETURN pg_catalog.hashtextextended(a, b::bigint);')));
        rowsOf(await run(spy('json_build_object(a text, b text, c text, d text)', 'json', 'RETURN pg_catalog.json_build_object(a, b, c, d);')));
        rowsOf(await run(spy('jsonb_path_query(j jsonb, p text)', 'SETOF jsonb', 'RETURN QUERY SELECT pg_catalog.jsonb_path_query(j, p::jsonpath);')));
        rowsOf(await run(spy('gbrain_fact_fingerprint(c character varying)', 'text', 'RETURN pg_catalog.md5(c);')));
        const spied = (o: Outcome) => ('code' in o ? o.message : '').includes('spy ');
        const softDelete = await run('UPDATE pages SET deleted_at = now() WHERE id = $1 RETURNING id', [ids.derived]);
        expect({ softDelete: spied(softDelete) ? softDelete : 'ok' }).toEqual({ softDelete: 'ok' });
        const page = failure(await run(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ('notes/again-example', 'note', 't', 'x', $1)`, [PURGED_HASH]));
        expect(page.message).toStartWith('purged_content:');
        const fact = failure(await run(`INSERT INTO facts (fact, source) VALUES ($1, 'probe')`, [PURGED_CLAIM]));
        expect(fact.message).toStartWith('purged_content:');
        const [held, heldOutput] = insertDerivation(JSON.stringify({ text: PURGED_CLAIM }));
        const derivation = failure(await run(held, [ids.takes, 3, heldOutput]));
        expect(derivation.message).toStartWith('derivation_purge_pending:');
      });
    } finally {
      await conn.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${WRITER}`);
    }
  });

  test('19. while a purge holds a source, a role RLS refuses gets the same 42501 inserting a fact into it as into a source that does not exist', async () => {
    const holder = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    const session = await holder.reserve();
    try {
      await session.unsafe(`BEGIN; SELECT id FROM sources WHERE id = 'default' FOR UPDATE`);
      for (const role of API_ROLES) {
        await as(conn, role, async run => {
          rowsOf(await run(`SET LOCAL lock_timeout = '1s'`));
          const insert = (source: string) => run(`INSERT INTO facts (fact, source, source_id) VALUES ('an unrelated claim', 'probe', $1)`, [source]);
          const locked = failure(await insert('default'));
          expect({ role, locked }).toEqual({ role, locked: failure(await insert('no-such-source-example')) });
          expect(locked.code).toBe('42501');
        });
      }
    } finally {
      await session.unsafe('ROLLBACK').catch(() => {});
      session.release();
      await holder.end();
    }
  });

  test('20. a purged take claim is refused for the owner on insert and update, and for a writer that cannot read take_purges on update', async () => {
    const [{ owner }] = await conn.unsafe<Array<{ owner: string }>>('SELECT current_user AS owner');
    for (const role of [owner!, WRITER]) {
      await as(conn, role, async run => {
        const purged = (o: Outcome) => ({ role, ...failure(o) });
        const refusal = { role, code: 'P0001', message: expect.stringContaining('purged_content: this take claim was purged') };
        if (role === owner) expect(purged(await run(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 7, $2, 'take', 'alice-example')`, [ids.takes, PURGED_TAKE]))).toEqual(refusal);
        const [take] = rowsOf(await run(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 8, 'an unrelated take', 'take', 'alice-example') RETURNING id`, [ids.takes]));
        expect(purged(await run('UPDATE takes SET claim = $1 WHERE id = $2', [PURGED_TAKE, take!.id]))).toEqual(refusal);
      });
    }
  });
});
