/**
 * GBRA-156: an unscoped remote read whose readable sources hold no page,
 * while other sources hold pages, is refused instead of answering empty.
 *
 * 1. Protects: a token with no source grant reads the default source plus the
 *    federated ones. A new source is not federated by default, so a brain
 *    whose pages all live in such sources answered every search with `[]`,
 *    which reads like a clean miss. The read is now refused with
 *    `sources_not_readable` (class host_only), whose fix is the host command
 *    that makes the pages readable (federate a source, with the user choosing
 *    which), without naming any source the connection cannot read.
 * 2. Fails when: the refusal is missing on an unscoped read whose scope holds
 *    no page, it leaks a hidden source id or page text, it fires on a real
 *    miss inside a scope that holds pages, on a brain where no source holds a
 *    page, or for a connection whose operator granted it sources (a token
 *    granted sources, or an OAuth client), or for a read that names a source.
 * 3. Existing coverage: `source_binding_narrowed` covers a bound stdio
 *    connection only (mcp-notice-channels).
 * 4. No production seam: production serve-http app, real tokens.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { callTool, clientCredentialsToken, envelopeOf, legacyToken, ownerCookie, registerOAuthClient, startServeHttp, type LiveServeHttp, type ToolResultWire } from './helpers/live-mcp-servers.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const HIDDEN = 'source-hidden';
const CANARY = 'harbourcanary';
const QUERY = 'quillmarsh ledger';
const READS = [
  ['search', { query: QUERY }],
  ['search', { query: QUERY, match: 'keyword' }],
  ['query', { query: QUERY, expand: false }],
  ['list_pages', {}],
  ['recall', { query: QUERY }],
] as const;

function rows(result: ToolResultWire): unknown {
  return JSON.parse(result.content[0]!.text);
}

for (const kind of testBackends()) {
  describe(`sources_not_readable refusal (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let serve: LiveServeHttp;
    let noGrant: string;
    let granted: string;
    let oauth: string;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1), ('source-empty', 'source-empty') ON CONFLICT (id) DO NOTHING`, [HIDDEN]);
      serve = await startServeHttp(engine, { surface: 'full' });
      noGrant = await legacyToken(engine, ['read']);
      granted = (await mintLegacyToken(engine, { name: 'granted-empty', takesHolders: ['world'], scopes: ['read'], sourceGrant: ['source-empty'] })).token;
      const client = await registerOAuthClient(serve, await ownerCookie(serve), 'read');
      oauth = await clientCredentialsToken(serve, client.clientId, client.clientSecret, 'read');
    }, 180_000);

    afterAll(async () => {
      await serve?.close();
      await close?.();
    }, 60_000);

    test('a brain where no source holds a page answers empty, as before', async () => {
      const out = await callTool(serve.base, noGrant, 'search', { query: QUERY });
      expect(out.isError).not.toBe(true);
      expect(rows(out)).toEqual([]);
    }, 60_000);

    test('pages arrive in a source the no-grant floor cannot read', async () => {
      await importFromContent(engine, 'notes/quillmarsh-ledger', `# Ledger\nThe quillmarsh ledger for the harbour team, ${CANARY}.`, { sourceId: HIDDEN, noEmbed: true });
    });

    for (const [tool, args] of READS) {
      test(`${tool} ${JSON.stringify(args)}: a no-grant token whose sources hold no page is refused with the host fix`, async () => {
        const out = await callTool(serve.base, noGrant, tool, args);
        expect(out.isError).toBe(true);
        const env = envelopeOf(out);
        expect(env.code).toBe('sources_not_readable');
        expect(env.class).toBe('host_only');
        expect(env.fix.argv).toEqual(['gbrain', 'sources', 'federate', '<source>']);
        expect(env.fix.inputs?.[0]?.name).toBe('source');
        const text = JSON.stringify(out.content);
        expect(text).not.toContain(HIDDEN);
        expect(text).not.toContain(CANARY);
      }, 60_000);
    }

    test('an OAuth client always carries a grant (at least its bound source), so it is not refused', async () => {
      const out = await callTool(serve.base, oauth, 'search', { query: QUERY });
      expect(out.isError).not.toBe(true);
      expect(rows(out)).toEqual([]);
    }, 60_000);

    test('a token the operator granted a source is not refused (its scope is deliberate)', async () => {
      const out = await callTool(serve.base, granted, 'search', { query: QUERY });
      expect(out.isError).not.toBe(true);
      expect(rows(out)).toEqual([]);
    }, 60_000);

    test('naming a source explicitly is not refused', async () => {
      for (const scope of [{ source_id: 'default' }, { source_ids: ['default'] }]) {
        const out = await callTool(serve.base, noGrant, 'search', { query: QUERY, ...scope });
        expect(out.isError).not.toBe(true);
        expect(rows(out)).toEqual([]);
      }
    }, 60_000);

    test('once the source is federated the same token reads the page, and a real miss is not refused', async () => {
      await engine.executeRaw(`UPDATE sources SET config = COALESCE(config, '{}'::jsonb) || '{"federated": true}'::jsonb WHERE id = $1`, [HIDDEN]);
      try {
        const hit = await callTool(serve.base, noGrant, 'search', { query: QUERY });
        expect(JSON.stringify(rows(hit))).toContain('quillmarsh-ledger');
        const miss = await callTool(serve.base, noGrant, 'search', { query: 'zzyzx nothing matches this' });
        expect(miss.isError).not.toBe(true);
        expect(rows(miss)).toEqual([]);
      } finally {
        await engine.executeRaw(`UPDATE sources SET config = config - 'federated' WHERE id = $1`, [HIDDEN]);
      }
    }, 60_000);

    test('a default source that holds a page but matches nothing answers empty, not refused', async () => {
      await importFromContent(engine, 'notes/floor-note', '# Floor\nAn unrelated note in the default source.', { sourceId: 'default', noEmbed: true });
      const out = await callTool(serve.base, noGrant, 'search', { query: QUERY });
      expect(out.isError).not.toBe(true);
      expect(rows(out)).toEqual([]);
    }, 60_000);
  });
}
