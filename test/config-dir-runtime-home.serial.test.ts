/**
 * configDir() must follow a runtime HOME change when GBRAIN_HOME is unset.
 *
 * Bun's os.homedir() snapshots HOME at process start (Node re-reads it). Test
 * files that set process.env.HOME = <tmp> and deleted GBRAIN_HOME therefore
 * resolved configDir() to the operator's real ~/.gbrain: the #2608 wrapper
 * test wrote its fake-binary autopilot-run.sh and a GBRAIN_TEST_MARKER_2608
 * env file there, and launchd ran that wrapper every minute.
 *
 * Every case runs in a child bun whose launch-time HOME is a scratch dir, so
 * a regression lands in that scratch dir and never in the real home. The
 * child deletes GBRAIN_HOME on purpose; this process never does.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const repoRoot = resolve(import.meta.dir, '..');

function runChild(script: string, launchHome: string, path = process.env.PATH ?? '') {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: { HOME: launchHome, PATH: path },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function withDirs(fn: (d: { launchHome: string; runtimeHome: string }) => void): void {
  const launchHome = mkdtempSync(join(tmpdir(), 'gbrain-runtime-home-launch-'));
  const runtimeHome = mkdtempSync(join(tmpdir(), 'gbrain-runtime-home-set-'));
  try {
    fn({ launchHome, runtimeHome });
  } finally {
    rmSync(launchHome, { recursive: true, force: true });
    rmSync(runtimeHome, { recursive: true, force: true });
  }
}

describe('configDir() honors a runtime HOME change', () => {
  test('HOME set after start, GBRAIN_HOME unset: <runtime HOME>/.gbrain, not the launch home', () => {
    withDirs(({ launchHome, runtimeHome }) => {
      const r = runChild(
        `delete process.env.GBRAIN_HOME;
         process.env.HOME = ${JSON.stringify(runtimeHome)};
         const { configDir } = await import('./src/core/config.ts');
         console.log(configDir());`,
        launchHome,
      );
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(join(runtimeHome, '.gbrain'));
    });
  });

  test('relative or empty HOME falls back to os.homedir()', () => {
    withDirs(({ launchHome }) => {
      for (const bad of ['relative/home', '   ']) {
        const r = runChild(
          `delete process.env.GBRAIN_HOME;
           process.env.HOME = ${JSON.stringify(bad)};
           const { configDir } = await import('./src/core/config.ts');
           console.log(configDir());`,
          launchHome,
        );
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(join(launchHome, '.gbrain'));
      }
    });
  });

  test('GBRAIN_HOME still wins over a runtime HOME', () => {
    withDirs(({ launchHome, runtimeHome }) => {
      const override = join(runtimeHome, 'override');
      const r = runChild(
        `process.env.GBRAIN_HOME = ${JSON.stringify(override)};
         process.env.HOME = ${JSON.stringify(runtimeHome)};
         const { configDir } = await import('./src/core/config.ts');
         console.log(configDir());`,
        launchHome,
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(join(override, '.gbrain'));
    });
  });

  test('pre-fix #2608 test shape: wrapper and env land under the runtime HOME, launch home untouched', () => {
    withDirs(({ launchHome, runtimeHome }) => {
      const binDir = join(runtimeHome, 'fake-bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'gbrain'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const repoDir = join(runtimeHome, 'repo-behavior');
      mkdirSync(repoDir, { recursive: true });
      const r = runChild(
        `delete process.env.GBRAIN_HOME;
         process.env.HOME = ${JSON.stringify(runtimeHome)};
         const { writeWrapperScript } = await import('./src/commands/autopilot.ts');
         console.log(writeWrapperScript(${JSON.stringify(repoDir)}, 'linux-cron'));`,
        launchHome,
        `${binDir}:/usr/bin:/bin`,
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe(join(runtimeHome, '.gbrain', 'autopilot-run.sh'));
      expect(existsSync(join(runtimeHome, '.gbrain', 'env'))).toBe(true);
      expect(existsSync(join(launchHome, '.gbrain'))).toBe(false);
    });
  });
});
