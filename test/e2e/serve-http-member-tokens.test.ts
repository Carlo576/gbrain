/**
 * Per-member tokens on one shared brain: two bearer tokens, one granted
 * source-a and one granted source-b, call `search` and `query` concurrently
 * from one process against one real `gbrain serve --http` on Postgres. Each
 * token's results stay inside its own grant on every call, and `source_ids`
 * cannot carry either token into the other member's source.
 *
 * 1. Protects: the multi-member bot pattern (one token per member, each
 *    narrowed to that member's sources) over the real HTTP transport.
 * 2. Fails when: the server resolves a call's scope from anything but that
 *    call's own token, or `source_ids` widens a token past its grant.
 * 3. Existing coverage (serve-http-source-grant) pins one token at a time.
 * 4. No production seam.
 *
 * Run: DATABASE_URL=... GBRAIN_TEST_ALLOW_DATABASE_URL=1 \
 *        bun test test/e2e/serve-http-member-tokens.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setupDB, teardownDB, getConn, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hashToken, generateToken } from '../../src/core/utils.ts';
import { importFromContent } from '../../src/core/import-file.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping E2E serve-http-member-tokens tests (DATABASE_URL not set)');

const PORT = 19158;
const BASE = `http://localhost:${PORT}`;
const MEMBERS = { a: 'mt-source-a', b: 'mt-source-b' } as const;
const CANARY = { a: 'canaryalpha', b: 'canarybravo' } as const;

describeE2E('/mcp per-member tokens on one shared brain', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let engine: PostgresEngine;
  const tokens = { a: '', b: '' };

  async function insertToken(name: string, sourceId: string): Promise<string> {
    const token = generateToken('gbrain_');
    await getConn().unsafe(
      `INSERT INTO access_tokens (id, name, token_hash, permissions) VALUES (gen_random_uuid(), $1, $2, $3::text::jsonb)`,
      [name, hashToken(token), JSON.stringify({ takes_holders: ['world'], source_id: sourceId })],
    );
    return token;
  }

  beforeAll(async () => {
    engine = await setupDB();
    const conn = getConn();
    await conn.unsafe(`DELETE FROM access_tokens WHERE name LIKE 'mt-e2e-%'`);
    for (const member of ['a', 'b'] as const) {
      await conn.unsafe(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [MEMBERS[member]]);
      const imported = await importFromContent(engine, `notes/ledger-${member}`,
        `# Quarry ledger\nQuarry ledger notes for member ${member}, ${CANARY[member]}.`, { sourceId: MEMBERS[member], noEmbed: true });
      expect(imported.status).toBe('imported');
      tokens[member] = await insertToken(`mt-e2e-${member}`, MEMBERS[member]);
    }
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', ['run', 'src/cli.ts', 'serve', '--http', '--port', String(PORT), '--public-url', BASE], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 60_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    try {
      const conn = getConn();
      await conn.unsafe(`DELETE FROM access_tokens WHERE name LIKE 'mt-e2e-%'`);
      await conn.unsafe(`DELETE FROM pages WHERE source_id IN ($1, $2)`, [MEMBERS.a, MEMBERS.b]);
      await conn.unsafe(`DELETE FROM sources WHERE id IN ($1, $2)`, [MEMBERS.a, MEMBERS.b]);
    } catch (e: any) {
      console.error(`[afterAll] fixture cleanup failed: ${e.message}`);
    }
    await teardownDB();
  }, 30_000);

  async function call(token: string, tool: 'search' | 'query', args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.text()).trim();
    const rpc = JSON.parse(body.startsWith('{') ? body : body.split('\n').filter(l => l.startsWith('data:')).pop()!.slice(5).trim());
    expect(rpc.error).toBeUndefined();
    return { isError: rpc.result.isError, text: rpc.result.content.map((c: { text: string }) => c.text).join('\n') };
  }

  function expectOwnOnly(member: 'a' | 'b', out: { isError?: boolean; text: string }): void {
    const other = member === 'a' ? 'b' : 'a';
    expect(out.isError).not.toBe(true);
    expect(out.text).toContain(CANARY[member]);
    expect(out.text).not.toContain(CANARY[other]);
    expect(out.text).not.toContain(MEMBERS[other]);
  }

  test('interleaved concurrent search and query calls never cross between the two tokens', async () => {
    const calls: Array<Promise<void>> = [];
    for (let round = 0; round < 8; round++) {
      for (const member of ['a', 'b'] as const) {
        for (const tool of ['search', 'query'] as const) {
          const args = { query: 'quarry ledger notes', fields: 'full', ...(tool === 'query' ? { expand: false } : {}), ...(round % 2 ? { source_ids: [MEMBERS[member]] } : {}) };
          calls.push(call(tokens[member], tool, args).then(out => expectOwnOnly(member, out)));
        }
      }
    }
    await Promise.all(calls);
  }, 60_000);

  test("source_ids naming the other member's source is refused for both tokens", async () => {
    for (const [member, other] of [['a', 'b'], ['b', 'a']] as const) {
      for (const tool of ['search', 'query'] as const) {
        for (const sourceIds of [[MEMBERS[other]], [MEMBERS[member], MEMBERS[other]]]) {
          const out = await call(tokens[member], tool, { query: 'quarry ledger notes', source_ids: sourceIds });
          expect(out.isError).toBe(true);
          expect(out.text).toContain('permission_denied');
          expect(out.text).not.toContain(CANARY[other]);
        }
      }
    }
  }, 60_000);
});
