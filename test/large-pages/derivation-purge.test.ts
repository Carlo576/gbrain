/**
 * Wave B PR 4 lane 4a round 2 (spec 11): a fact purge leaves no page_segment_derivations row holding the claim, for a
 * row of a retired occurrence, a derivation racing the purge and a page demoted to inline (PGLite arm; the PostgreSQL
 * arm is test/e2e/derivation-purge-postgres.test.ts). Cases in test/helpers/derivation-purge-cases.ts.
 */
import { registerDerivationPurgeCases } from '../helpers/derivation-purge-cases.ts';

registerDerivationPurgeCases('pglite');
