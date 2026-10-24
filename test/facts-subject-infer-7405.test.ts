/**
 * #7405: fact subject inference. A clear single-person fact was rejected as
 * ambiguous when it carried a currency amount ("CHF 80") or opened with a
 * label word ("Invoice total ...", "Work session ..."), and an entity named
 * only as an example inside an inventory ("... including Automation Example
 * notes") was linked as the subject. Those unresolved non-names must not
 * compete, an example must not establish the subject, and a real entity whose
 * name is a currency code or label word still competes. The two-entity and
 * unknown-issuer controls stay unresolved. Synthetic data only; PGLite always,
 * Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { inferFactSubject } from '../src/core/facts/subject-infer.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ backend: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

const page = (engine: BrainEngine, slug: string, title: string, type: string, sourceId = 'default') =>
  importFromContent(engine, slug, `---\ntitle: ${title}\ntype: ${type}\nfacts_backstop: false\n---\n\n# ${title}\n`, { noEmbed: true, sourceId });

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    engines.push({ backend: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ backend: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
  for (const { engine } of engines) {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING`);
    for (const sourceId of ['default', 'source-a']) {
      await page(engine, 'people/alice-example', 'Alice Example', 'person', sourceId);
      await page(engine, 'companies/acme-example', 'Acme Example', 'company', sourceId);
      await page(engine, 'ideas/automation-example', 'Automation Example', 'concept', sourceId);
    }
    // source-a also holds real entities named like a currency code and two label words.
    for (const title of ['CHF', 'Invoice', 'Work']) await page(engine, `companies/${title.toLowerCase()}`, title, 'company', 'source-a');
  }
}, 120_000);

afterAll(async () => {
  for (const { engine } of engines) await engine.disconnect();
  await closePostgres?.();
});

const ALICE = 'people/alice-example';
const CASES: Array<{ id: string; fact: string; expect: string | null }> = [
  { id: 'identity-control', fact: 'Alice Example prefers async updates', expect: ALICE },
  { id: 'currency', fact: 'Alice Example paid CHF 80 for gardening', expect: ALICE },
  { id: 'invoice-label', fact: 'Invoice total for gardening work billed to Alice Example: CHF 80', expect: ALICE },
  { id: 'work-label', fact: 'Work session on 2025-01-01: 2 hours of garden labour for Alice Example (CHF 80)', expect: ALICE },
  { id: 'amount-first', fact: 'Alice Example was billed 80 CHF for gardening', expect: ALICE },
  { id: 'two-real-entities', fact: 'Acme Example issued an invoice to Alice Example', expect: null },
  { id: 'unknown-issuer', fact: 'Northstar Example issued an invoice to Alice Example', expect: null },
  { id: 'incidental-example', fact: 'Has a venture research folder with 17 enrolled documents including Automation Example notes', expect: null },
  { id: 'such-as-example', fact: 'Has research notes on concepts such as Automation Example', expect: null },
  { id: 'example-literal', fact: 'Has research notes including ideas/automation-example', expect: null },
  { id: 'currency-without-amount', fact: 'CHF billed Alice Example CHF 80', expect: null },
  { id: 'label-mid-sentence', fact: 'Alice Example joined Work Example last year', expect: null },
  { id: 'subject-also-named-as-example', fact: 'ideas/automation-example lists 17 documents including ideas/automation-example notes', expect: 'ideas/automation-example' },
];

describe('#7405 fact subject inference: currency amounts, label openers and incidental examples', () => {
  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;
    for (const mode of ['relink', 'write'] as const) {
      for (const c of CASES) {
        test(`[${backend}] ${mode}: ${c.id}`, async () => {
          const result = await inferFactSubject(engineFor(), 'default', { fact: c.fact, mode });
          expect(result.slug).toBe(c.expect);
        });
      }

      test(`[${backend}] ${mode}: an incidental example from another page never matches the page`, async () => {
        expect(await inferFactSubject(engineFor(), 'default', {
          fact: 'Has 17 documents including Automation Example notes', pageSlug: 'companies/acme-example', mode,
        })).toMatchObject({ slug: null, reason: 'ambiguous' });
      });

      test(`[${backend}] ${mode}: real entities named CHF, Invoice or Work still compete`, async () => {
        for (const fact of [
          'Alice Example paid CHF 80 for gardening',
          'Invoice total for gardening work billed to Alice Example: 80',
          'Work session on 2025-01-01: 2 hours of garden labour for Alice Example',
        ]) {
          expect(await inferFactSubject(engineFor(), 'source-a', { fact, mode })).toMatchObject({ slug: null, reason: 'ambiguous' });
        }
        expect((await inferFactSubject(engineFor(), 'source-a', { fact: 'Alice Example prefers async updates', mode })).slug).toBe(ALICE);
      });
    }
  }
});
