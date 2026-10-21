/**
 * Seeded property test of the conversation facts deletion invariant, PGLite arm (PR 4 lane 4b round 5). Cases:
 * test/helpers/conversation-facts-property-cases.ts. Postgres arm: test/e2e/conversation-facts-property-postgres.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsPropertyCases } from '../helpers/conversation-facts-property-cases.ts';

let brain: AppendBrain;
let fresh: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); fresh = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); await fresh.close(); }, 120_000);

describe('conversation facts deletion invariant [pglite]', () => {
  defineConversationFactsPropertyCases({ getBrain: () => brain, getFresh: () => fresh });
});
