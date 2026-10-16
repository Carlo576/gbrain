/**
 * The doctor JSON goldens replace the latest schema migration number with
 * `<latest>` (test/helpers/doctor-json-golden.ts) so a migration renumber does
 * not churn them. These cases pin what the placeholder may hide: only the
 * migration registry maximum is normalized, any other number still diffs, and
 * the golden guard fails when the doctor's reported latest version is not the
 * registry maximum.
 */
import { describe, expect, test } from 'bun:test';
import { doctorJsonNormalizer, expectSchemaLatestMatchesRegistry, normalizeDoctorText, type GbrainRun } from './helpers/doctor-json-golden.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

function run(message: string): GbrainRun {
  return { args: [], exitCode: 0, stdout: '', stderr: '', roots: {}, json: { checks: [{ name: 'schema_version', message }] } };
}

describe('doctor golden <latest> placeholder', () => {
  test('normalizes only the registry maximum in schema_version messages', () => {
    expect(normalizeDoctorText(`Version ${LATEST} (latest: ${LATEST})`, {})).toBe('Version <latest> (latest: <latest>)');
    expect(normalizeDoctorText(`Version ${LATEST - 1}, latest is ${LATEST}. Fix: gbrain apply-migrations --yes`, {}))
      .toBe(`Version ${LATEST - 1}, latest is <latest>. Fix: gbrain apply-migrations --yes`);
    expect(normalizeDoctorText(`Version ${LATEST + 1} (latest: ${LATEST + 1})`, {})).toBe(`Version ${LATEST + 1} (latest: ${LATEST + 1})`);
    expect(normalizeDoctorText(`daily_limit ${LATEST}`, {})).toBe(`daily_limit ${LATEST}`);
  });

  test('golden guard accepts the registry maximum and rejects anything else', () => {
    expect(() => expectSchemaLatestMatchesRegistry(run(`Version ${LATEST} (latest: ${LATEST})`))).not.toThrow();
    expect(() => expectSchemaLatestMatchesRegistry(run(`Version ${LATEST - 1} (latest: ${LATEST - 1})`))).toThrow(/registry maximum/);
    expect(() => expectSchemaLatestMatchesRegistry(run(`Version ${LATEST - 1}, latest is ${LATEST}.`))).toThrow(/Fix: {2}bun run build:schema-migrations/);
    expect(() => expectSchemaLatestMatchesRegistry({ ...run(''), json: null })).toThrow(/no schema_version check/);
  });
});


test('terminal byte workload normalization keeps capacity policy and other resources visible', () => {
  const normalize = (patch: Record<string, unknown>) => doctorJsonNormalizer().apply({ ...run(''),
    json: { resource: 'terminal_bytes', used: 120, per_day_7d: 80, max_day_7d: 80, net_per_day_7d: 40,
      limit: 1000, status: 'ok', ...patch } });
  expect(normalize({ used: 180 })).toEqual(normalize({}));
  expect(normalize({ limit: 900 })).not.toEqual(normalize({}));
  expect(normalize({ status: 'warn' })).not.toEqual(normalize({}));
  expect(normalize({ resource: 'lifetime_ids', used: 180 })).not.toEqual(normalize({ resource: 'lifetime_ids' }));
});
