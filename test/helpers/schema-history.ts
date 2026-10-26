/**
 * Schema-history fixtures (#7645): a fresh brain as each release since v260
 * created it, captured by scripts/capture-schema-history-fixture.ts from that
 * release's own engine and stored as gzipped SQL under
 * test/fixtures/schema-history/<engine>/v<N>.sql.gz.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diffCatalogSnapshots, formatCatalogDiffForFailure, type CatalogSnapshot } from './schema-diff.ts';

export type SchemaHistoryEngine = 'pglite' | 'postgres';

/** The first schema version with a fixture; every later shipped version has one. */
export const FIRST_SCHEMA_HISTORY_VERSION = 260;

export const SCHEMA_HISTORY_DIR = resolve(import.meta.dir, '..', 'fixtures', 'schema-history');

export function schemaHistoryVersions(engine: SchemaHistoryEngine): number[] {
  return readdirSync(join(SCHEMA_HISTORY_DIR, engine))
    .map((name) => /^v(\d+)\.sql\.gz$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export function schemaHistorySql(engine: SchemaHistoryEngine, version: number): string {
  return Buffer.from(Bun.gunzipSync(readFileSync(join(SCHEMA_HISTORY_DIR, engine, `v${version}.sql.gz`)))).toString('utf8');
}

export interface InstalledSchema {
  catalog: CatalogSnapshot;
  /** Raw function bodies keyed like the catalog (`name(identity args)`). */
  functionBodies: Map<string, string>;
}

const collapseWhitespace = (body: string | undefined) => (body ?? '').replace(/\s+/g, ' ').trim();
const withoutParentheses = (value: unknown) => JSON.stringify(value).replace(/[()]/g, '');

/**
 * The catalog difference between a fresh install and an upgraded brain, '' when
 * none. Two differences are not drift: a function body that differs only in
 * whitespace (the blob and the migration that last replaced it indent it
 * differently), and a constraint trigger's WHEN clause, whose OR chain the
 * fixture's restore deparses with fewer parentheses (same expression).
 */
export function schemaHistoryDrift(fresh: InstalledSchema, upgraded: InstalledSchema): string {
  const drift = diffCatalogSnapshots(fresh.catalog, upgraded.catalog).filter((d) => {
    if (d.kind !== 'changed') return true;
    if (d.section === 'triggers') return withoutParentheses(d.expected) !== withoutParentheses(d.actual);
    if (d.section !== 'functions') return true;
    const { bodySha256: _e, ...expected } = d.expected as Record<string, unknown>;
    const { bodySha256: _a, ...actual } = d.actual as Record<string, unknown>;
    return JSON.stringify(expected) !== JSON.stringify(actual)
      || collapseWhitespace(fresh.functionBodies.get(d.key)) !== collapseWhitespace(upgraded.functionBodies.get(d.key));
  });
  return drift.length === 0 ? '' : formatCatalogDiffForFailure(drift);
}
