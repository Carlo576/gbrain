/**
 * #7619: `--flag=value` on CLI_ONLY commands must mean exactly what
 * `--flag value` means, or refuse. The validator accepted the `=` form of
 * every registered flag while most handlers read only the separate-token form,
 * so the value was dropped with no error (`serve --access=read-only` served
 * every write tool). cliOnlyFlagArgs is the argv every CLI_ONLY handler
 * receives; this table runs it over every registered flag of every command.
 */
import { describe, expect, test } from 'bun:test';
import { CLI_ONLY, cliOnlyFlagArgs, validateCommandFlags } from '../src/cli/main.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { EQUALS_FORM_READERS } from '../src/cli/flag-equals.ts';
import { loadCuratedHelp } from '../src/cli/help/render.ts';
import { parseAccessFlag, parseSurfaceFlag } from '../src/mcp/surface.ts';

const PASSTHROUGH = new Set(['call', 'config', 'retrieval-upgrade', 'migrate']);

async function argvFor(command: string, args: string[]): Promise<string[]> {
  const r = await cliOnlyFlagArgs(command, args);
  if ('refusal' in r) throw new Error(`refused: ${r.refusal.message}`);
  return r.args;
}

async function refusalFor(command: string, args: string[]): Promise<string | null> {
  const r = await cliOnlyFlagArgs(command, args);
  return 'refusal' in r ? r.refusal.message : null;
}

describe('#7619 table: every registered CLI_ONLY flag', () => {
  test('the = form reaches the handler as the bare form, is kept for an =-reading handler, or refuses', async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const command of CLI_ONLY) {
      const legal = CLI_FLAG_REGISTRY[command];
      if (!legal || PASSTHROUGH.has(command)) continue;
      const types = new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type]));
      for (const flag of legal) {
        checked++;
        const value = 'alpha=beta,gamma';
        const r = await cliOnlyFlagArgs(command, [`${flag}=${value}`]);
        const expected = EQUALS_FORM_READERS[command]?.includes(flag) ? 'kept'
          : types.get(flag) === 'boolean' || flag.startsWith('--no-') ? 'refused' : 'split';
        const got = 'refusal' in r ? 'refused'
          : r.args.length === 1 && r.args[0] === `${flag}=${value}` ? 'kept'
          : JSON.stringify(r.args) === JSON.stringify(await argvFor(command, [flag, value])) && r.args[0] === flag && r.args[1] === value ? 'split' : `other ${JSON.stringify(r.args)}`;
        if (got !== expected) wrong.push(`${command} ${flag}: expected ${expected}, got ${got}`);
        if (got === 'split' && validateCommandFlags(command, r.args) !== null) wrong.push(`${command} ${flag}: split argv fails validation`);
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  });

  test('a switch-like value on a flag of unknown arity refuses for every split flag', async () => {
    const accepted: string[] = [];
    for (const command of CLI_ONLY) {
      const legal = CLI_FLAG_REGISTRY[command];
      if (!legal || PASSTHROUGH.has(command)) continue;
      const types = new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type]));
      for (const flag of legal) {
        if (EQUALS_FORM_READERS[command]?.includes(flag) || types.has(flag)) continue;
        for (const value of ['true', 'false', 'FALSE', 'yes', 'no', 'on', 'off', '0', '1', '', '--x']) {
          if (await refusalFor(command, [`${flag}=${value}`]) === null) accepted.push(`${command} ${flag}=${value}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });
});

describe('#7619 split rules', () => {
  test('a value containing = splits at the first =', async () => {
    expect(await argvFor('serve', ['--public-url=https://brain.example.com/?a=b'])).toEqual(['--public-url', 'https://brain.example.com/?a=b']);
  });

  test('tokens after a bare -- stay passthrough', async () => {
    expect(await argvFor('serve', ['--', '--access=read-only'])).toEqual(['--', '--access=read-only']);
  });

  test('an unknown flag keeps its token so the validator names it', async () => {
    expect(await argvFor('serve', ['--definitely-not-a-flag=x'])).toEqual(['--definitely-not-a-flag=x']);
    expect(validateCommandFlags('serve', ['--definitely-not-a-flag=x'])).toBe('--definitely-not-a-flag');
  });

  test('a curated number or enum flag splits any value, switch-like ones included', async () => {
    expect(await argvFor('serve', ['--stdio-idle-timeout=0'])).toEqual(['--stdio-idle-timeout', '0']);
    expect(await argvFor('serve', ['--token-ttl=60'])).toEqual(['--token-ttl', '60']);
  });

  test('a curated switch refuses the = form with the bare spelling', async () => {
    for (const token of ['--source-guard=true', '--source-guard=false', '--http=1']) {
      const message = await refusalFor('serve', [token]);
      expect(message).toContain(token);
      expect(message).toContain('is a switch and takes no value');
    }
  });

  test('a negation refuses the = form', async () => {
    expect(await refusalFor('sync', ['--no-pull=true'])).toContain('--no-pull is a switch');
  });

  test('commands with their own =-aware parsers keep their argv', async () => {
    expect(await argvFor('config', ['set', 'k', '--x=true'])).toEqual(['set', 'k', '--x=true']);
    expect(await argvFor('jobs', ['submit', 'shell', '--params={"a":1}'])).toEqual(['submit', 'shell', '--params={"a":1}']);
    expect(await argvFor('pages', ['purge-deleted', '--older-than=72'])).toEqual(['purge-deleted', '--older-than=72']);
    expect(await argvFor('embed', ['--pace=gentle'])).toEqual(['--pace=gentle']);
    expect(await argvFor('doctor', ['--scope=brain'])).toEqual(['--scope=brain']);
  });

});

describe('#7619 serve: the dropped safety flags reach the handler', () => {
  test('--access=read-only and --surface=verbs parse as their bare forms', async () => {
    const argv = await argvFor('serve', ['--access=read-only', '--surface=verbs']);
    expect(argv).toEqual(['--access', 'read-only', '--surface', 'verbs']);
    expect(parseAccessFlag(argv)).toBe('read-only');
    expect(parseSurfaceFlag(argv)).toBe('verbs');
    expect(parseAccessFlag(await argvFor('serve', ['--access', 'read-only']))).toBe('read-only');
    expect(parseSurfaceFlag(await argvFor('serve', ['--surface', 'starter']))).toBe('starter');
  });

  test('--token-ttl=60 reaches the --token-ttl reader', async () => {
    const argv = await argvFor('serve', ['--http', '--token-ttl=60']);
    expect(argv[argv.indexOf('--token-ttl') + 1]).toBe('60');
  });

  test('--source-guard=true refuses instead of leaving the guard off', async () => {
    const r = await cliOnlyFlagArgs('serve', ['--source-guard=true']);
    expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    expect('refusal' in r && r.refusal.suggestion).toBe('Write --source-guard on its own, or leave it out.');
  });
});
