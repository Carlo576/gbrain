/**
 * trust_release_unpreviewed_fields doctor check (#7656) on a brain with no trust releases: ok, read-only, categorized.
 * The listing itself runs on real releases in test/trust-release-preview-binding.test.ts (PGLite and Postgres).
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { trustReleaseUnpreviewedEntry } from '../src/commands/doctor/checks/trust-release-unpreviewed.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

describe('trust_release_unpreviewed_fields doctor check', () => {
  test('a brain with no trust release is ok and the check is categorized', async () => {
    const [check] = await trustReleaseUnpreviewedEntry.run({ engine } as unknown as DoctorContext) as Check[];
    expect(check).toMatchObject({ name: 'trust_release_unpreviewed_fields', status: 'ok', details: { total: 0, items: [] } });
    expect(categorizeCheck('trust_release_unpreviewed_fields')).toBe('brain');
  }, 60_000);
});
