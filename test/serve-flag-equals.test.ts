/**
 * #7619 (real failure path): `gbrain serve` safety flags in the `--flag=value`
 * form over a real CLI process on a hermetic PGLite brain. Before the fix the
 * entry accepted these tokens and serve never read them: `--access=read-only`
 * and `--surface=verbs` served every write tool, `--token-ttl=59` and
 * `--http --access=read-only` started an HTTP server instead of refusing, and
 * `--source-guard=true` started with the write guard off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { operations } from '../src/core/operations.ts';
import { allowedOpNames, isReadOnlyOperation } from '../src/mcp/surface.ts';

let home: string;
let env: Record<string, string>;

function cli(args: string[]) {
  return spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8', input: '', timeout: 30_000 });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-flag-equals-serve-'));
  env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined });
  delete env.GBRAIN_SOURCE;
  delete env.GBRAIN_SURFACE;
  expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive']).status).toBe(0);
}, 120_000);

afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe('serve --flag=value', () => {
  test('stdio --access=read-only --surface=verbs serves only read-only verbs and refuses writes', async () => {
    const transport = new StdioClientTransport({ command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--access=read-only', '--surface=verbs'], cwd: process.cwd(), env });
    const client = new Client({ name: 'gbrain-flag-equals-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const listed = (await client.listTools()).tools.map(tool => tool.name);
      expect(listed.length).toBeGreaterThan(0);
      const verbs = allowedOpNames(operations, 'verbs');
      for (const name of listed) {
        expect(verbs.has(name)).toBe(true);
        expect(isReadOnlyOperation(operations.find(op => op.name === name)!)).toBe(true);
      }
      expect(listed).not.toContain('put_page');
      const write = await client.callTool({ name: 'put_page', arguments: { slug: 'notes/injected', content: '# Injected' } }) as { isError?: boolean };
      expect(write.isError).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 60_000);

  test('--http --token-ttl=59 refuses through the handler range check', () => {
    const r = cli(['serve', '--http', '--port', '0', '--token-ttl=59']);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain('--token-ttl must be an integer number of seconds');
  });

  test('--http --access=read-only refuses with the per-token fix', () => {
    const r = cli(['serve', '--http', '--port', '0', '--access=read-only']);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain('gbrain auth rescope-token <name> --operations');
  });

  test('--source-guard=true exits 2 naming the bare spelling, before serving', () => {
    const r = cli(['serve', '--source-guard=true']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--source-guard is a switch and takes no value');
  });

  test('a refusal under --json prints one invalid_params envelope on stdout', () => {
    const r = cli(['serve', '--source-guard=true', '--json']);
    expect(r.status).toBe(2);
    const envelope = JSON.parse(r.stdout.trim());
    expect(envelope.code).toBe('invalid_params');
    expect(envelope.message).toContain('--source-guard is a switch and takes no value');
  });

  test('eval longmemeval refuses a value on its own switch instead of turning it on', () => {
    const r = cli(['eval', 'longmemeval', 'data-example.jsonl', '--retrieval-only', '--judge=false']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--judge is a switch and takes no value');
    expect(r.stderr).not.toContain('cannot be combined');
  });

  // Value: protects=auth create --scopes=read exits 2 and mints no token (never a full-access one); fails_when=--scopes=… is dropped or kept and auth create runs; why_new=in-process rows never ran the handler or checked the token table; seam=none; no_claim=the separate-form --scopes path (PGLite brain)
  test('auth create --scopes=read refuses and mints no token', () => {
    const r = cli(['auth', 'create', 'bot-example', '--scopes=read']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('takes --scopes <value> as two arguments');
    expect(r.stderr).toContain('--scopes <value>');
    const list = cli(['auth', 'list']);
    expect(list.status).toBe(0);
    expect(list.stdout + list.stderr).not.toContain('bot-example');
  });

  // Value: protects=--yes=n refuses instead of consenting and a split value never retargets forget; brain left intact; fails_when=the entry drops or splits these tokens; why_new=in-process rows never checked the brain afterwards; seam=none; no_claim=a fact-level purge check (no facts in the hermetic brain)
  test('reinit-pglite --yes=n and forget --purge --reason=3 34 refuse before touching the brain', () => {
    const brainDir = join(home, '.gbrain');
    const before = readdirSync(brainDir).sort();
    expect(existsSync(join(brainDir, 'brain.pglite'))).toBe(true);
    for (const [args, message] of [
      [['reinit-pglite', '--yes=n'], 'Write --yes on its own'],
      [['forget', '--purge', '--reason=3', '34', '--yes'], 'takes --reason <value> as two arguments'],
    ] as const) {
      const r = cli([...args]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stdout).toBe('');
    }
    expect(readdirSync(brainDir).sort()).toEqual(before);
    expect(cli(['auth', 'list']).status).toBe(0);
  });

  test('the direct auth.ts entry and a bare -- refuse --scopes=read too', () => {
    const direct = spawnSync('bun', ['--no-env-file', 'run', 'src/commands/auth.ts', 'create', 'bot-direct-example', '--scopes=read'], { cwd: process.cwd(), env, encoding: 'utf8', input: '', timeout: 30_000 });
    expect(direct.status).toBe(2);
    expect(direct.stderr).toContain('--scopes=…');
    const dashed = cli(['auth', 'create', '--', 'bot-dashed-example', '--scopes=read']);
    expect(dashed.status).toBe(2);
    const list = cli(['auth', 'list']);
    expect(list.stdout + list.stderr).not.toContain('bot-direct-example');
    expect(list.stdout + list.stderr).not.toContain('bot-dashed-example');
  });

  test('serve -- --access=read-only still narrows to read-only', async () => {
    const r = cli(['serve', '--http', '--port', '0', '--', '--access=read-only']);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain('gbrain auth rescope-token <name> --operations');
  });

  // Value: protects=--help and a bare -- never let a write run with an = token the gate refuses; fails_when=the gate is skipped on help or stops at -- on a sub that reads past it; why_new=only serve (which prints help) was covered; seam=none; no_claim=other self-help handlers (one representative)
  test('frontmatter generate --fix leaves the file untouched with --dry-run= behind --help or --', () => {
    const notes = mkdtempSync(join(home, 'notes-'));
    const page = join(notes, 'alpha.md');
    writeFileSync(page, '# Alpha\n\nBody text.\n');
    for (const tail of [['--dry-run=true', '--help'], ['--', '--dry-run=true']]) {
      const r = cli(['frontmatter', 'generate', page, '--fix', '--include-catch-all', ...tail]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--dry-run=…');
      expect(readFileSync(page, 'utf8')).toBe('# Alpha\n\nBody text.\n');
    }
  });

  test('the direct auth.ts entry refuses an unknown flag instead of minting a full-access token', () => {
    const direct = spawnSync('bun', ['--no-env-file', 'run', 'src/commands/auth.ts', 'create', 'bot-typo-example', '--Scopes=read'], { cwd: process.cwd(), env, encoding: 'utf8', input: '', timeout: 30_000 });
    expect(direct.status).toBe(2);
    expect(direct.stderr).toContain('unknown flag --Scopes');
    expect(cli(['auth', 'list']).stdout).not.toContain('bot-typo-example');
  });

  test('a self-help handler never runs on the help path with an = token the gate refuses', () => {
    const r = cli(['connectors', 'auth', 'chatgpt', '--token=placeholder-example', '--help']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--token=…');
    expect(r.stderr).not.toContain('placeholder-example');
  });

  test('the direct auth.ts entry runs auth with the separate form', () => {
    const direct = spawnSync('bun', ['--no-env-file', 'run', 'src/commands/auth.ts', 'create', 'bot-direct-ok-example', '--scopes', 'read'], { cwd: process.cwd(), env, encoding: 'utf8', input: '', timeout: 30_000 });
    expect(direct.status).toBe(0);
    const list = cli(['auth', 'list']);
    expect(list.stdout + list.stderr).toContain('bot-direct-ok-example');
  });

  test('--help still answers when an = token would refuse', () => {
    const r = cli(['serve', '--source-guard=true', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gbrain serve');
  });
});
