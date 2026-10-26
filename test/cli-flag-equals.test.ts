/**
 * #7619: `--flag=value` on CLI_ONLY commands must mean exactly what
 * `--flag value` means or refuse. The validator accepted the `=` form of
 * every registered flag while most handlers read only the separate-token
 * form, so the value was dropped with no error (`serve --access=read-only`
 * served every write tool). cliOnlyFlagArgs is the argv every CLI_ONLY
 * handler receives; these tables run it over every registered flag of every
 * command.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { CLI_ONLY, cliOnlyFlagArgs, validateCommandFlags } from '../src/cli/main.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { EQUALS_FORM_READERS, OWN_EQUALS_PARSERS, knownSwitches } from '../src/cli/flag-equals.ts';
import { SYNC_FLAGS } from '../src/core/sync-flags.ts';
import { loadCuratedHelp } from '../src/cli/help/render.ts';
import { parseAccessFlag, parseSurfaceFlag } from '../src/mcp/surface.ts';
import { parseMovementArgs } from '../src/commands/sources-writer-movement.ts';
import { parseAddTypeArgs } from '../src/commands/schema-add-type.ts';

const PASSTHROUGH = new Set(['call', 'config', 'retrieval-upgrade']);

async function argvFor(command: string, args: string[]): Promise<string[]> {
  const r = await cliOnlyFlagArgs(command, args);
  if ('refusal' in r) throw new Error(`refused: ${r.refusal.message}`);
  return r.args;
}

async function refusalFor(command: string, args: string[]): Promise<string | null> {
  const r = await cliOnlyFlagArgs(command, args);
  return 'refusal' in r ? r.refusal.message : null;
}

async function ownTable(command: string): Promise<Map<string, string>> {
  const types = new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type] as [string, string]));
  if (command === 'sync') for (const [flag, spec] of Object.entries(SYNC_FLAGS as Record<string, { arity: string }>)) if (!types.has(flag)) types.set(flag, spec.arity);
  return types;
}

describe('#7619 table: every registered CLI_ONLY flag', () => {
  test('the = form splits only on the command\'s own value flags and otherwise refuses', async () => {
    const switches = await knownSwitches();
    const wrong: string[] = [];
    let checked = 0;
    const outcomes = { split: 0, kept: 0, refused: 0 };
    for (const command of CLI_ONLY) {
      const legal = CLI_FLAG_REGISTRY[command];
      if (!legal || PASSTHROUGH.has(command) || OWN_EQUALS_PARSERS.has(command)) continue;
      const own = await ownTable(command);
      for (const flag of legal) {
        checked++;
        const value = 'alpha=beta,gamma';
        const r = await cliOnlyFlagArgs(command, [`${flag}=${value}`]);
        const got = 'refusal' in r ? 'refused'
          : r.args.length === 1 && r.args[0] === `${flag}=${value}` ? 'kept'
          : JSON.stringify(r.args) === JSON.stringify([flag, value]) ? 'split' : `other ${JSON.stringify(r.args)}`;
        if (got in outcomes) outcomes[got as keyof typeof outcomes]++;
        const listed = EQUALS_FORM_READERS[command]?.includes(flag);
        const isSwitch = own.has(flag) ? own.get(flag) === 'boolean' : flag.startsWith('--no-') || switches.has(flag);
        if (got === 'split' && (!own.has(flag) || own.get(flag) === 'boolean')) wrong.push(`${command} ${flag}: split without a value in the command's own table`);
        if (got === 'split' && validateCommandFlags(command, (r as { args: string[] }).args) !== null) wrong.push(`${command} ${flag}: split argv fails validation`);
        if (got === 'kept' && !listed) wrong.push(`${command} ${flag}: kept whole for a handler that may read only the separate form`);
        if (got !== 'refused' && isSwitch && !listed) wrong.push(`${command} ${flag}: a switch was not refused`);
        if (got === 'refused' && (listed || own.has(flag) && !isSwitch)) wrong.push(`${command} ${flag}: refused a form the handler reads`);
        if (got.startsWith('other')) wrong.push(`${command} ${flag}: ${got}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
    expect(outcomes.split).toBeGreaterThan(50);
    expect(outcomes.refused).toBeGreaterThan(1000);
  });

  test('an empty or flag-like value refuses on every flag, and no refusal echoes the value', async () => {
    const wrong: string[] = [];
    for (const command of CLI_ONLY) {
      const legal = CLI_FLAG_REGISTRY[command];
      if (!legal || PASSTHROUGH.has(command) || OWN_EQUALS_PARSERS.has(command)) continue;
      for (const flag of legal) {
        if (EQUALS_FORM_READERS[command]?.includes(flag)) continue;
        for (const value of ['', '--x', '-y', '-h']) {
          if (await refusalFor(command, [`${flag}=${value}`]) === null) wrong.push(`${command} ${flag}=${value} accepted`);
        }
        const message = await refusalFor(command, [`${flag}=-SecretValue-alpha`]);
        if (message?.includes('SecretValue')) wrong.push(`${command} ${flag}: refusal echoes the value`);
      }
    }
    expect(wrong).toEqual([]);
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

  test('the sync flag table splits sync values', async () => {
    expect(await argvFor('sync', ['--source=source-a', '--interval=60'])).toEqual(['--source', 'source-a', '--interval', '60']);
  });

  test('a curated switch refuses the = form with the bare spelling', async () => {
    for (const token of ['--source-guard=true', '--source-guard=false', '--http=1']) {
      const message = await refusalFor('serve', [token]);
      expect(message).toContain(`${token.split('=')[0]}=…`);
      expect(message).toContain('is a switch and takes no value');
    }
  });

  test('a negation refuses the = form', async () => {
    expect(await refusalFor('sync', ['--no-pull=true'])).toContain('--no-pull is a switch');
    expect(CLI_FLAG_REGISTRY.forget).not.toContain('--no-purge');
    expect(await refusalFor('forget', ['--no-purge=1'])).toContain('--no-purge is a switch');
  });

  test('commands that read the = form themselves keep their argv', async () => {
    expect(await argvFor('config', ['set', 'k', '--x=true'])).toEqual(['set', 'k', '--x=true']);
    expect(await argvFor('jobs', ['submit', 'shell', '--params={"a":1}'])).toEqual(['submit', 'shell', '--params={"a":1}']);
    expect(await argvFor('pages', ['purge-deleted', '--older-than=72'])).toEqual(['purge-deleted', '--older-than=72']);
    expect(await argvFor('embed', ['--pace=gentle'])).toEqual(['--pace=gentle']);
    expect(await argvFor('doctor', ['--scope=brain'])).toEqual(['--scope=brain']);
    expect(await argvFor('search', ['--limit=5'])).toEqual(['--limit=5']);
    expect(await argvFor('retrieval-upgrade', ['--yes=true'])).toEqual(['--yes=true']);
    expect(await argvFor('migrate', ['embeddings', '--to=x'])).toEqual(['embeddings', '--to=x']);
    expect(await argvFor('eval', ['brainbench', '--x=1'])).toEqual(['brainbench', '--x=1']);
    expect(await argvFor('call', ['x', '--y=true'])).toEqual(['x', '--y=true']);
    expect(await argvFor('edge-proposals', ['list', '--status=all'])).toEqual(['list', '--status=all']);
  });

  test('a strict spec whose when is false falls through to the entry rule', async () => {
    expect(await refusalFor('skillpack', ['reference', '--harness=claude-code'])).toContain('reads --harness only as a separate argument');
    expect(await refusalFor('skillpack', ['reference', '--harness', 'claude-code', '--dry-run=true'])).toContain('--dry-run=…');
  });

  test('EQUALS_FORM_READERS matches the handlers that read only the = form', () => {
    const files = [...new Glob('src/{commands,cli}/**/*.ts').scanSync('.')].map(p => [p, readFileSync(p, 'utf8')] as const);
    const listed = new Set(Object.values(EQUALS_FORM_READERS).flat());
    const unlisted: string[] = [];
    for (const [path, src] of files) {
      for (const m of src.matchAll(/(?:startsWith|includes)\('(--[a-z0-9-]+)=/g)) {
        if (!new RegExp(`['"]${m[1]}['"]`).test(src) && !listed.has(m[1]!)) unlisted.push(`${path} ${m[1]}`);
      }
    }
    expect(unlisted).toEqual([]);
    for (const flag of listed) expect(files.some(([, src]) => src.includes(`'${flag}=`) || src.includes(`'${flag}'`) && /\$\{\w+\}=/.test(src))).toBe(true);
  });
});

describe('#7619 refusals that keep consent, scope and targets right', () => {
  test('a switch never splits into the switch plus a stray positional', async () => {
    for (const [command, args] of [
      ['reinit-pglite', ['--yes=n']], ['reinit-pglite', ['--yes=nope']], ['reinit-pglite', ['--yes=disabled']],
      ['forget', ['--purge=n']], ['embed', ['--stale=alice-example']], ['embed', ['--all=alice-example']], ['sync', ['--dry-run=alice-example']],
      ['forget', ['--purge', '--continue=12', '--yes', '--request-id', 'r1']],
      ['frontmatter', ['validate', 'x.md', '--fix', '--include-ambiguous=n']],
      ['init', ['--non-interactive=n']], ['init', ['--rebuild=n']], ['init', ['--supabase=on']], ['init', ['--pglite=1']],
      ['dream', ['--unsafe-bypass-dream-guard=never']], ['dream', ['--unsafe-bypass-dream-guard=1']],
      ['auth', ['--enable-dcr-insecure=disabled']], ['sync', ['--status=true']], ['forget', ['--status=yes']],
      ['setup', ['--remove=yes']], ['bootstrap', ['--remove=yes']], ['mcp', ['expose', '--remove=yes']], ['quarantine', ['--yes=n']],
      ['skillpack', ['scaffold', '--harness', 'claude-code', '--dry-run=true']],
    ] as const) {
      const token = args.find(a => a.includes('='))!;
      expect(CLI_FLAG_REGISTRY[command]).toContain(token.split('=')[0]!);
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    }
  });

  test('a value flag the handler reads only as a separate argument refuses with that spelling instead of being dropped', async () => {
    for (const [command, args, flag] of [
      ['auth', ['create', 'bot-example', '--scopes=read'], '--scopes'], ['auth', ['create', 'bot-example', '--takes-holders=world'], '--takes-holders'],
      ['connect', ['https://a.example', '--scopes=read'], '--scopes'], ['takes', ['propose', '--accept=12'], '--accept'],
      ['reinit-pglite', ['--path=/tmp/brain-example'], '--path'], ['bootstrap', ['interview', '--confirm=abc123'], '--confirm'],
      ['extract', ['links', '--source', 'db', '--source-id=source-a'], '--source-id'], ['extract', ['--stale', '--source-id=source-a'], '--source-id'],
      ['trust', ['explain', 'ref-example', '--source=source-a'], '--source'], ['jobs', ['work', '--concurrency=4'], '--concurrency'],
      ['forget', ['34', '--reason=stale-example'], '--reason'], ['export', ['--dir=out-example'], '--dir'],
      ['beliefs', ['replay-purges', '--purge-mirror=/abs/mirror'], '--purge-mirror'], ['skillpack', ['scaffold', '--harness=claude-code'], '--harness'],
    ] as const) {
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.message).toContain(`reads ${flag} only as a separate argument`);
      expect('refusal' in r && r.refusal.suggestion).toContain(`${flag} <value>`);
    }
  });

  test('a flag value never becomes the numeric or slug target of a mutating subcommand', async () => {
    for (const [command, args] of [
      ['forget', ['--purge', '--reason=3', '34', '--dry-run']], ['forget', ['--purge', '--source=7', '34', '--yes', '--request-id', 'r1']],
      ['edge-proposals', ['accept', '--limit=3', '7']], ['edge-proposals', ['accept', '--row=3', '7']],
      ['decide', ['proposals', 'accept', '--limit=3', '7']],
      ['loops', ['drop', '--note=7', '12']], ['pages', ['unpurge', '--source-id=people/alice-example', 'people/bob-example']],
    ] as const) expect(await refusalFor(command, [...args])).not.toBeNull();
  });

  test('subcommands with their own = parser get their argv unchanged', async () => {
    for (const [command, args] of [
      ['takes', ['resolve', 'people/alice-example', '--row=1', '--by=alice-example']],
      ['takes', ['add', 'people/alice-example', '--claim=x', '--by=1']],
      ['sources', ['reconcile', 'notes', '--apply=plan-example.json', '--remove-backup=id-example']],
      ['sources', ['add', 'source-a', '--history-days=1', '--token-env=TOKEN_EXAMPLE']],
      ['auth', ['local-writer', 'register', '--expected-epoch=1', '--scopes=read,write']],
      ['repair', ['file-drift', '--generation=1', '--keep=database']],
      ['eval', ['longmemeval', 'data.jsonl', '--top-k=1', '--autocut=on']],
      ['skillpack', ['remove', '--harness=claude-code', '--persona=alice-example']],
      ['schema', ['add-type', 'note', '--alias=n', '--primitive=entity']],
      ['git', ['commit-push', '--message=alpha', '--resolve=a.md=ours']],
    ] as const) expect(await argvFor(command, [...args])).toEqual([...args]);
  });

  test('own = parsers refuse a value on their own switches', () => {
    expect(() => parseMovementArgs(['source-a', '--warn-only=false'])).toThrow('--warn-only is a switch');
    expect(() => parseMovementArgs(['source-a', '--json=false'])).toThrow('--json is a switch');
    expect(parseMovementArgs(['source-a', '--warn-only', '--json'])).toMatchObject({ warnOnly: true, json: true });
    expect(() => parseAddTypeArgs(['note', '--primitive=entity', '--no-prefix=false'])).toThrow('--no-prefix is a switch');
    expect(() => parseAddTypeArgs(['note', '--primitive=entity', '--prefix=notes/', '--extractable=false'])).toThrow('--extractable is a switch');
    expect(parseAddTypeArgs(['note', '--primitive=entity', '--no-prefix'])).toMatchObject({ noPrefix: true });
  });

  test('every option parser in src/commands that splits = itself is an OWN_EQUALS_PARSERS entry', () => {
    const OWNERS: Record<string, string | null> = {
      'src/commands/company-brain-connect.ts': 'sources connect', 'src/commands/company-brain-inspect.ts': 'sources inspect',
      'src/commands/eval-longmemeval.ts': 'eval longmemeval', 'src/commands/git.ts': 'git', 'src/commands/persistence-admin.ts': 'auth local-writer',
      'src/commands/repair.ts': 'repair', 'src/commands/schema-add-type.ts': 'schema add-type', 'src/commands/skillpack/harness.ts': 'skillpack remove',
      'src/commands/source-reconcile.ts': 'sources reconcile', 'src/commands/sources-lifecycle-args.ts': 'sources add',
      'src/commands/sources-reset-upstream.ts': 'sources reset-upstream', 'src/commands/sources-writer-movement.ts': 'sources writer',
      'src/commands/takes-mutation.ts': 'takes add',
      // normalizeReindexArgs splits its own value flags; the entry refuses other = forms before it runs.
      'src/commands/reindex.ts': null,
    };
    const found = [...new Glob('src/commands/**/*.ts').scanSync('.')].filter(p => /\b(?:eq|equal|equals) = \w+\.indexOf\('='\)/.test(readFileSync(p, 'utf8'))).sort();
    expect(found).toEqual(Object.keys(OWNERS).sort());
    for (const owner of Object.values(OWNERS)) if (owner) expect(OWN_EQUALS_PARSERS.has(owner)).toBe(true);
  });

  test("a command's own switch wins over a value of the same name elsewhere", async () => {
    expect(await refusalFor('sync', ['status', '--detail=high'])).toContain('--detail is a switch');
    expect(await refusalFor('schema', ['detect', '--fields=x'])).toContain('--fields is a switch');
  });

  test('--json=true is the JSON switch; other values refuse', async () => {
    expect(await argvFor('doctor', ['--json=true'])).toEqual(['--json']);
    expect(await argvFor('sync', ['--json=true'])).toEqual(['--json']);
    expect(await refusalFor('sync', ['--json=false'])).toContain('--json is a switch');
  });

  test('a refused credential value is never echoed', async () => {
    const r = await cliOnlyFlagArgs('auth', ['--token=-AbcSecretValue123']);
    expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    expect(JSON.stringify(r)).not.toContain('AbcSecretValue123');
    const plain = await cliOnlyFlagArgs('auth', ['create', 'bot-example', '--scopes=AbcSecretValue123']);
    expect(JSON.stringify(plain)).not.toContain('AbcSecretValue123');
  });

  test('a curated value flag refuses an empty or flag-like value', async () => {
    for (const token of ['--access=', '--surface=--x', '--public-url=', '--token-ttl=', '--access=-y']) {
      const r = await cliOnlyFlagArgs('serve', [token]);
      expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    }
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
