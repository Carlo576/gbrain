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

/** The first schema version with a fixture; the fixtures run contiguously from here to the newest one captured. */
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

const collapseWhitespace = (body: string) => body.replace(/\s+/g, ' ').trim();

type BooleanNode = { op: 'AND' | 'OR'; items: BooleanNode[] } | { text: string };

const printBoolean = (node: BooleanNode): string => ('text' in node ? node.text : `(${node.items.map(printBoolean).join(` ${node.op} `)})`);

/**
 * Canonical text of a SQL expression with nested AND/OR groups flattened
 * (`((a OR b) OR c)` and `(a OR b OR c)` print the same) and redundant
 * parentheses dropped, while a regrouping across AND and OR still prints
 * differently.
 */
function canonicalBoolean(sql: string): string {
  const tokens = (sql.match(/'(?:[^']|'')*'|\(|\)|\bAND\b|\bOR\b|[^()'\s]+|\s+/gi) ?? []);
  let i = 0;
  const keyword = (t: string | undefined) => t?.toUpperCase();
  const group = (op: 'AND' | 'OR', items: BooleanNode[]): BooleanNode => items.length === 1 ? items[0]
    : { op, items: items.flatMap(item => ('op' in item && item.op === op ? item.items : [item])) };
  const atom = (): BooleanNode => {
    const parts: BooleanNode[] = [];
    while (i < tokens.length && tokens[i] !== ')' && keyword(tokens[i]) !== 'AND' && keyword(tokens[i]) !== 'OR') {
      if (tokens[i] === '(') {
        i++;
        parts.push(or());
        if (tokens[i] === ')') i++;
      } else {
        if (tokens[i].trim()) parts.push({ text: tokens[i] });
        i++;
      }
    }
    return parts.length === 1 ? parts[0] : { text: parts.map(printBoolean).join(' ') };
  };
  const and = (): BooleanNode => { const items = [atom()]; while (keyword(tokens[i]) === 'AND') { i++; items.push(atom()); } return group('AND', items); };
  const or = (): BooleanNode => { const items = [and()]; while (keyword(tokens[i]) === 'OR') { i++; items.push(and()); } return group('OR', items); };
  let out = '';
  while (i < tokens.length) {
    out += printBoolean(or());
    if (i < tokens.length) out += tokens[i++];
  }
  return out;
}

/**
 * A restored constraint trigger deparses its WHEN clause with nested OR chains
 * flattened (same expression, fewer parentheses). Parentheses that regroup AND
 * and OR still count.
 */
export function sameUpToOrChainParentheses(expected: unknown, actual: unknown): boolean {
  return canonicalBoolean(JSON.stringify(expected)) === canonicalBoolean(JSON.stringify(actual));
}

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
    if (d.section === 'triggers') return !sameUpToOrChainParentheses(d.expected, d.actual);
    if (d.section !== 'functions') return true;
    const { bodySha256: _e, ...expected } = d.expected as Record<string, unknown>;
    const { bodySha256: _a, ...actual } = d.actual as Record<string, unknown>;
    const [freshBody, upgradedBody] = [fresh.functionBodies.get(d.key), upgraded.functionBodies.get(d.key)];
    return JSON.stringify(expected) !== JSON.stringify(actual) || freshBody === undefined || upgradedBody === undefined
      || collapseWhitespace(freshBody) !== collapseWhitespace(upgradedBody);
  });
  return drift.length === 0 ? '' : formatCatalogDiffForFailure(drift);
}
