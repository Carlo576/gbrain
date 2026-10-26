/**
 * #7632: the seven purge and withdrawal guards are SECURITY DEFINER from migration v276 on. A CREATE OR REPLACE of one
 * of them resets SECURITY DEFINER and its search_path to whatever the statement says, so a later definition must carry
 * both. The only definitions without them are the frozen modules the migrations before v276 apply (v276 then makes the
 * functions definers), and those modules may not be imported by anything else.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DEFINER_GUARDS, GUARD_SEARCH_PATH } from '../src/core/guard-definer.ts';

const REPO = resolve(import.meta.dir, '..');
const FROZEN = ['src/core/facts/purge-schema.ts', 'src/core/facts/insert-guard-schema.ts', 'src/core/facts/withdrawal-schema.ts'];
const DEFINER_MIGRATION = 276;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const sources = files(join(REPO, 'src')).map(path => ({ path: relative(REPO, path), text: readFileSync(path, 'utf8') }));

describe('guard definitions keep SECURITY DEFINER (#7632)', () => {
  test('every CREATE OR REPLACE of a guard outside the frozen pre-v276 modules is SECURITY DEFINER with the pinned path', () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (FROZEN.includes(path)) continue;
      for (const { fn } of DEFINER_GUARDS) {
        for (const match of text.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(\\)[\\s\\S]*?\\bAS \\$`, 'g'))) {
          const header = match[0].replaceAll(/\$\{GUARD_SEARCH_PATH\}/g, GUARD_SEARCH_PATH);
          if (!header.includes('SECURITY DEFINER') || !header.includes(`search_path = ${GUARD_SEARCH_PATH}`)) offenders.push(`${path}: ${fn}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the frozen modules that define guards without SECURITY DEFINER are imported only by migrations before v276', () => {
    const importers: string[] = [];
    for (const { path, text } of sources) {
      for (const frozen of FROZEN) {
        const name = frozen.split('/').pop()!.replace('.ts', '');
        if (!new RegExp(`from '[^']*/${name}\\.ts'`).test(text)) continue;
        const version = /schema-migrations\/v(\d+)-/.exec(path)?.[1];
        if (version !== undefined && Number(version) < DEFINER_MIGRATION) continue;
        // Importing a constant that is not a guard definition is fine.
        const imported = new RegExp(`import \\{([^}]*)\\} from '[^']*/${name}\\.ts'`).exec(text)?.[1] ?? '';
        if (/MEMORY_PURGE_GUARD_SQL|FACT_INSERT_GUARD_SQL|FACT_WITHDRAWAL_SCHEMA_(SQL|STATEMENTS)|FACT_WITHDRAWAL_NORMALIZED_SQL/.test(imported)) importers.push(`${path} imports ${imported.trim()}`);
      }
    }
    expect(importers).toEqual([]);
  });
});
