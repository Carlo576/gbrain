/**
 * Incremental conversation facts on a segmented page, PGLite arm (wave-b spec 8.2, PR 4 lane 4b). Cases:
 * test/helpers/conversation-facts-incremental-cases.ts. Postgres arm: test/e2e/conversation-facts-incremental-postgres.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineDerivationSpendCases } from '../helpers/derivation-spend-cases.ts';
import { defineConversationFactsIncrementalCases, defineSegmentedAtomsCases, defineSegmentedBackstopCases, defineSegmentReceiptDoctorCases } from '../helpers/conversation-facts-incremental-cases.ts';

let brain: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); }, 120_000);

describe('conversation facts incremental [pglite]', () => {
  defineConversationFactsIncrementalCases({ getBrain: () => brain });
  defineSegmentedBackstopCases({ getBrain: () => brain });
  defineSegmentedAtomsCases({ getBrain: () => brain });
  defineSegmentReceiptDoctorCases({ getBrain: () => brain });
  defineDerivationSpendCases({ getBrain: () => brain });
});
