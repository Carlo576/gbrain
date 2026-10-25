/**
 * G6 (git-canonical memory): `gbrain brainstorm --save` and `gbrain lsd --save` on a strict (canonical: git) managed
 * source are door-only.
 *
 * Both save through persistSavedIdea (commands/brainstorm.ts), with the page content the CLI builds after the run
 * (serializeMarkdown of the run's frontmatter and body, so no model call is involved, as in test/brainstorm/save.test.ts).
 * After three saves every idea page is at HEAD with the bytes on disk, the tree is clean, the git-gap census reports no
 * gap, and the saves make at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-brainstorm-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { buildIdeaSlug, persistSavedIdea } from '../src/commands/brainstorm.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

const runs: Array<{ label: 'brainstorm' | 'lsd'; question: string }> = [
  { label: 'brainstorm', question: 'How could alice-example grow acme-example' },
  { label: 'brainstorm', question: 'What would bob-example build next' },
  { label: 'lsd', question: 'Why does acme-example ship weekly' },
];
const saved = (label: string, question: string) => serializeMarkdown({ mode: label, question, source_kind: label }, `# ${question}\n\nIdea body.`, '',
  { type: 'note', title: `${label === 'lsd' ? 'LSD' : 'Brainstorm'}: ${question}`, tags: [] });

for (const backend of testBackends()) describe(`[${backend}] G6: brainstorm and lsd --save on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('three saves: every idea page at HEAD, clean tree, no census gap, one commit per group', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const base = head(root);
    const slugs = runs.map((run, i) => buildIdeaSlug(run.question, run.label, `g6000${i}`));
    const outcomes = [];
    for (const [i, run] of runs.entries()) outcomes.push(await persistSavedIdea(engine, { slug: slugs[i]!, content: saved(run.label, run.question), provenanceVia: run.label }));
    console.log(`[G6 brainstorm/${backend}] outcomes=${JSON.stringify(outcomes.map(o => ({ dbSaved: o.dbSaved, dbError: o.dbError?.slice(0, 120), held: o.held, written: o.writeThrough.written, skipped: o.writeThrough.skipped })))}`);
    const m = await measureBatch(engine, 'default', root, base, slugs);
    console.log(describeMeasure(`brainstorm/${backend}`, m));
    expect(outcomes.map(o => o.dbSaved)).toEqual(slugs.map(() => true));
    expectDoorOnly(m, expect);
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);
});
