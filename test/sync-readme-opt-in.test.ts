import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { isSyncable } from '../src/core/sync.ts';
import { withEnv } from './helpers/with-env.ts';

test('authored README opt-in reaches both discovery paths without widening safety exclusions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-readme-'));
  try {
    for (const file of ['README.md', 'guides/README.md', 'vendor/README.md', '.hidden/README.md', 'schema.md', 'log.md', 'RESOLVER.md']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '# Fixture\n');
    }
    writeFileSync(join(root, '.gbrainignore'), 'private/README.md\n');
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private/README.md'), '# Excluded by operator\n');
    for (const git of [false, true]) {
      if (git) {
        execFileSync('git', ['-C', root, 'init', '-q']);
        execFileSync('git', ['-C', root, 'add', '-A']);
      }
      await withEnv({ GBRAIN_SYNC_INCLUDE_README: undefined }, async () => {
        expect(isSyncable('README.md')).toBe(false);
        expect(collectSyncableFiles(root).map(f => relative(root, f))).toEqual([]);
      });
      await withEnv({ GBRAIN_SYNC_INCLUDE_README: '1' }, async () => {
        expect(isSyncable('README.md')).toBe(true);
        expect(isSyncable('guides/README.md')).toBe(true);
        expect(collectSyncableFiles(root).map(f => relative(root, f)).sort()).toEqual(['README.md', 'guides/README.md']);
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
