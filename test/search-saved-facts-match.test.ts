/**
 * Saved facts in `search` (retrieval.saved_facts): a fact saved with
 * `remember` is found by the next search for its words. Words match whole,
 * after stemming with the brain's full-text language ("renews" and "renewal"
 * share a stem; "count" no longer matches inside "countersigned"), and a fact
 * needs three quarters of the query's words, as before. Among equal matches
 * the newest comes first; at most five facts ride a reply.
 *
 * `search.saved_facts_supersede` (default off): a newer fact carrying a
 * correction cue that shares the query's words with an older returned fact is
 * returned ahead of it, and the older one is labelled `corrected_by`. The
 * fixture is the shape of a harness case where a channel post was corrected
 * in another channel and every search returned the retracted figure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { SAVED_FACTS_SUPERSEDE_KEY } from '../src/core/search/saved-facts-match.ts';
import { withEnv } from './helpers/with-env.ts';

const WRITER = { remote: true, transport: 'http' as const, sourceId: 'default' };
const REMOTE = { ...WRITER, auth: { token: 't', clientId: 'sf-client', clientName: 'sf', scopes: ['read'], expiresAt: Date.now() / 1000 + 3600 } };

const FIRST = 'Alice Example wrote in #team-a on 2026-09-02: For your records, no action needed: Orbix Home Goods renews at 52 seats. I will file the signed form once countersigned.';
const CORRECTION = 'Alice Example wrote in #team-b on 2026-09-02: Correction for your records, no action needed: the signed Orbix form says 46 seats, not what I posted in #team-a this morning. Ignore the 52, I was reading the draft.';
const QUESTION = 'Bob Example wrote in a direct message on 2026-09-04: What seat count did Orbix land on for the renewal? I am fixing the seat column in the morning report.';
const WORDINGS = ['Orbix seats renewal', 'Orbix renewal seats', 'Orbix seat count renewal', 'Orbix Home Goods renews seats'];

type Fact = { id: number; fact: string; corrected_by?: number };
let engine: PGLiteEngine;
const ids: Record<string, number> = {};

async function remember(fact: string, validFrom: string): Promise<number> {
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'remember', { fact, provenance: 'fixture', valid_from: validFrom }, { ...WRITER, writeWaitMs: 30_000 }));
  expect(res.isError).toBeFalsy();
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact = $1', [fact]);
  return Number(row.id);
}

async function search(query: string): Promise<{ facts: Fact[]; text: string }> {
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query }, REMOTE));
  const retrieval = (res._meta?.retrieval ?? {}) as { saved_facts?: Fact[] };
  return { facts: (retrieval.saved_facts ?? []).map(f => ({ ...f, id: Number(f.id) })), text: res.content.map(c => c.text).join('\n') };
}

const order = (facts: Fact[], id: number) => facts.findIndex(f => f.id === id);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title, body] of [
    ['accounts/orbix', 'Orbix Home Goods account', 'Account notes for Orbix Home Goods. Renewal cycle is annual. Seat counts are on the signed form.'],
    ['notes/renewals', 'Renewal tracker', 'Track every renewal: seats, price, signed form.'],
    ['notes/seat-column', 'Seat column', 'The morning report has a seat column per account.'],
  ] as const) {
    await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'note', title, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  ids.first = await remember(FIRST, '2026-09-02T09:00:00Z');
  // Saved with the same time as the post it corrects, as a flush of both posts saves them.
  ids.correction = await remember(CORRECTION, '2026-09-02T09:00:00Z');
  ids.question = await remember(QUESTION, '2026-09-04T09:00:00Z');
  ids.lease = await remember('Delta Example countersigned the warehouse lease.', '2026-09-01T09:00:00Z');
  ids.olderLease = await remember('The warehouse lease runs five years.', '2026-08-01T09:00:00Z');
  ids.newerLease = await remember('The warehouse lease renews in March.', '2026-08-15T09:00:00Z');
  ids.otherAccount = await remember('Kappa Example renews at 30 seats.', '2026-09-01T10:00:00Z');
  ids.delta = await remember('Delta Example has 50 seats, not 55.', '2026-08-01T09:00:00Z');
  ids.deltaAck = await remember('Correction noted: Delta Example has 50 seats, not 55.', '2026-08-01T09:05:00Z');
  ids.omega = await remember('Correction for the record: Omega Example stays with Carol Example.', '2026-07-01T09:00:00Z');
  ids.omegaAck = await remember('Correction noted: Omega Example stays with Carol Example.', '2026-07-01T09:05:00Z');
  ids.sigma = await remember('Correction: Sigma Example has 46 seats, not 52.', '2026-06-01T09:00:00Z');
  ids.sigmaAgain = await remember('Correction again: Sigma Example has 44 seats.', '2026-06-02T09:00:00Z');
  // A correction the remote caller may not read never comes back and never relabels a fact it can read.
  await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, visibility, source, valid_from)
    VALUES ('default', 'Correction: Orbix renewal seats are 40, ignore the earlier posts.', 'fact', 'private', 'fixture', '2026-09-03')`);
}, 180_000);
afterAll(async () => { await engine.disconnect(); });

describe('search saved facts: stem-aware whole-word matching', () => {
  test('the post comes back for every wording through its word forms; partial matches do not', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    for (const q of WORDINGS) {
      const { facts } = await search(q);
      expect(facts.map(f => f.id), q).toContain(ids.first);
      // The correction shares two words (the company and the seats): under three quarters.
      expect(facts.map(f => f.id), q).not.toContain(ids.correction);
      expect(facts.map(f => f.id), q).not.toContain(ids.otherAccount);
      expect(facts.some(f => f.corrected_by !== undefined), q).toBe(false);
      expect(facts.length, q).toBeLessThanOrEqual(5);
    }
  });

  test('a query word matches whole words only', async () => {
    const { facts } = await search('count lease');
    expect(facts.map(f => f.id)).not.toContain(ids.lease);
  });

  test('newest first among equal matches', async () => {
    const { facts } = await search('warehouse lease');
    expect(order(facts, ids.newerLease)).toBeGreaterThanOrEqual(0);
    expect(order(facts, ids.newerLease)).toBeLessThan(order(facts, ids.olderLease));
  });

  test('a fact the remote caller may not read never comes back', async () => {
    for (const q of WORDINGS) expect((await search(q)).text, q).not.toContain('are 40');
  });
});

describe('search.saved_facts_supersede on', () => {
  test('the correction comes back ahead of the fact it corrects, which is labelled, for every wording', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      for (const q of WORDINGS) {
        const { facts, text } = await search(q);
        expect(order(facts, ids.correction), q).toBeGreaterThanOrEqual(0);
        expect(order(facts, ids.correction), q).toBeLessThan(order(facts, ids.first));
        expect(facts.find(f => f.id === ids.first)?.corrected_by, q).toBe(ids.correction);
        expect(facts.find(f => f.id === ids.question)?.corrected_by, q).toBeUndefined();
        expect(facts.find(f => f.id === ids.correction)?.corrected_by, q).toBeUndefined();
        expect(text, q).toContain('corrected by a newer saved fact');
        expect(text, q).not.toContain('are 40');
        // Only a correction comes in under three quarters, not any fact sharing two words.
        expect(facts.map(f => f.id), q).not.toContain(ids.otherAccount);
        expect(facts.length, q).toBeLessThanOrEqual(5);
      }
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('an acknowledgement that adds no figure relabels nothing', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const { facts } = await search('Delta seats');
      expect(facts.map(f => f.id)).toEqual(expect.arrayContaining([ids.delta, ids.deltaAck]));
      expect(facts.some(f => f.corrected_by !== undefined)).toBe(false);
      // Acknowledging a correction does not correct it.
      const omega = await search('Omega Carol');
      expect(omega.facts.map(f => f.id)).toEqual(expect.arrayContaining([ids.omega, ids.omegaAck]));
      expect(omega.facts.some(f => f.corrected_by !== undefined)).toBe(false);
      // A correction of a correction that brings a new figure still corrects it.
      const sigma = await search('Sigma seats');
      expect(sigma.facts.find(f => f.id === ids.sigma)?.corrected_by).toBe(ids.sigmaAgain);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });

  test('a newer fact with no correction cue relabels nothing', async () => {
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'true');
    try {
      const { facts } = await search('warehouse lease');
      expect(facts.some(f => f.corrected_by !== undefined)).toBe(false);
    } finally {
      await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    }
  });
});
