/**
 * Wave B PR 4 lane 4a round 2 (spec 11), Postgres arm: a fact purge leaves no page_segment_derivations row holding the
 * claim, for a row of a retired occurrence, a derivation racing the purge and a page demoted to inline. Cases in
 * test/helpers/derivation-purge-cases.ts; PGLite arm: test/large-pages/derivation-purge.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationPurgeCases } from '../helpers/derivation-purge-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationPurgeCases('postgres');
else describe.skip('purge leaves no derivation row holding the claim (postgres)', () => { test('needs DATABASE_URL', () => {}); });
