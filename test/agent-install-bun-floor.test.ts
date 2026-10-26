/**
 * An in-agent helper written before Bun 1.4.4 became the floor stages Bun 1.4.3
 * for --upgrade. The new package's setup entry must refuse that runtime before
 * it commits an artifact the CLI then refuses to start (#7674).
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentSetupCli } from '../src/core/agent-install/entry.ts';
import { MINIMUM_BUN_VERSION } from '../src/core/runtime-version.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('setup refuses a staged Bun below the floor before touching the install root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-agent-floor-'));
  roots.push(root);
  const calls: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((line: string) => { calls.push(line); });
  try {
    const args = ['--root', root, '--harness', 'grok-bot', '--bundle', join(root, 'bundle'), '--source-ref', 'a'.repeat(40), '--json'];
    expect(await runAgentSetupCli(args, '1.4.3')).toBe(1);
  } finally { output.mockRestore(); }
  const result = JSON.parse(calls.pop()!);
  expect(result).toMatchObject({ ok: false, reason: 'runtime_below_floor' });
  expect(result.message).toContain(`needs Bun ${MINIMUM_BUN_VERSION} or newer, but the setup helper staged Bun 1.4.3`);
  expect(result.message).toContain('--upgrade');
  expect(readdirSync(root)).toEqual([]);
  expect(existsSync(join(root, '.gbrain'))).toBe(false);
});
