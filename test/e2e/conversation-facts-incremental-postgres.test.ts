/**
 * Incremental conversation facts on a segmented page, Postgres arm (wave-b spec 8.2, PR 4 lane 4b), including the
 * facts.source_window double-encoding check (jsonb_typeof = 'object') PGLite can't catch. Cases:
 * test/helpers/conversation-facts-incremental-cases.ts. PGLite arm: test/large-pages/conversation-facts-incremental.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineConversationFactsIncrementalCases } from '../helpers/conversation-facts-incremental-cases.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('conversation facts incremental [postgres]', () => {
  let brain: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain('postgres'); }, 120_000);
  afterAll(async () => { await brain.close(); }, 120_000);
  defineConversationFactsIncrementalCases({ getBrain: () => brain });
});
