/**
 * `npm_squat` through the real CLI: `gbrain doctor --only npm_squat --json`
 * with an unrelated npm package named "gbrain" on PATH, and with one installed
 * globally (a fake `npm root -g`) whose bin is not on PATH. Both warn with a
 * structured fix: remove it, install from the latest-stable ref, apply the
 * schema migrations (#218). Temp dirs only; the fake npm prints a path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gb, oneDocument } from './helpers/agent-journey.ts';

let home: string;
let npmRoot: string;
let pathBin: string; // gbrain → unrelated package
let npmBin: string; // npm printing npmRoot, no gbrain

function foreignPackage(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gbrain', version: '1.0.0', bin: { gbrain: 'cli.js' } }));
  writeFileSync(join(dir, 'cli.js'), '#!/usr/bin/env node\nconsole.log("not gbrain");\n');
  chmodSync(join(dir, 'cli.js'), 0o755);
  return join(dir, 'cli.js');
}

const squatOf = (doc: Record<string, any>) => (doc.checks as Array<Record<string, any>>).find(c => c.name === 'npm_squat');
const pathWith = (dir: string) => [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':');

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-npm-squat-'));
  pathBin = join(home, 'path-bin');
  mkdirSync(pathBin);
  symlinkSync(foreignPackage(join(home, 'npm-prefix-a', 'lib', 'node_modules', 'gbrain')), join(pathBin, 'gbrain'));
  npmRoot = join(home, 'npm-prefix-b', 'lib', 'node_modules');
  foreignPackage(join(npmRoot, 'gbrain'));
  npmBin = join(home, 'npm-bin');
  mkdirSync(npmBin);
  writeFileSync(join(npmBin, 'npm'), `#!/bin/sh\necho ${npmRoot}\n`);
  chmodSync(join(npmBin, 'npm'), 0o755);
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('doctor npm_squat', () => {
  test('an unrelated package on PATH warns with remove → install → #218 recovery', async () => {
    const res = await gb(home, ['doctor', '--only', 'npm_squat', '--json'], { env: { PATH: pathWith(pathBin), BUN_INSTALL: join(home, 'bun') } });
    const check = squatOf(oneDocument(res, 'doctor npm_squat'));
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('on PATH resolves to an unrelated npm package');
    expect(check!.fix.next).toBe('ask_user');
    expect(check!.fix.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
    expect(check!.fix.then.argv).toEqual(['bun', 'install', '-g', 'github:garrytan/gbrain#latest-stable']);
    expect(check!.fix.then.then.argv).toEqual(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install']);
    expect(check!.fix.verify.argv.slice(0, 5)).toEqual(['gbrain', 'doctor', '--only', 'npm_squat', '--json']);
  }, 120_000);

  test('an unrelated global npm install off PATH warns too', async () => {
    const res = await gb(home, ['doctor', '--only', 'npm_squat', '--json'], { env: { PATH: pathWith(npmBin), BUN_INSTALL: join(home, 'bun') } });
    const check = squatOf(oneDocument(res, 'doctor npm_squat'));
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain(`installed globally at ${realpathSync(join(npmRoot, 'gbrain'))}`);
    expect(check!.fix.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
  }, 120_000);
});
