/**
 * GBRA-248 W0b: a re-init that fell back to keyless only because no provider
 * key was in reach (a cold GBRAIN_HOME, a container restarted without its
 * key) must not write embedding_disabled over a content database that already
 * carries an embedding identity. It keeps the database's model and width in
 * the file plane instead and says which key to set. A fresh database, an
 * explicit --no-embedding and a database already keyless by choice behave as
 * before.
 */
import type { BrainEngine } from '../core/engine.ts';
import { readPrimaryEmbeddingStores, readStoredEmbeddingIdentity } from '../core/stored-embedding-identity.ts';
import { resolveRecipe } from '../core/ai/model-resolver.ts';
import type { ResolvedAIOptions } from './init.ts';

/** The embedding identity src/schema.sql seeds into every new config table; it names no choice anyone made. */
const SCHEMA_SEED_IDENTITY = { model: 'text-embedding-3-large', dimensions: 1536 };

/** What the file plane keeps: the database's identity, or nothing (no embedding_disabled) when it holds vectors whose identity cannot be confirmed. */
export interface KeptEmbedding { model?: string; dimensions?: number }

export async function keptEmbeddingIdentity(engine: BrainEngine, aiOpts: ResolvedAIOptions | undefined, fresh: boolean): Promise<KeptEmbedding | null> {
  if (!aiOpts?.noEmbedding || !aiOpts.implicitKeyless || fresh) return null;
  if (await engine.getConfig('embedding_disabled').catch(() => null) === 'true') return null;
  let embedded = false;
  for (const table of await readPrimaryEmbeddingStores(engine)) {
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE embedding IS NOT NULL) AS present`);
    if (row?.present) { embedded = true; break; }
  }
  const stored = await readStoredEmbeddingIdentity(engine).catch(() => null);
  const seeded = !stored?.model || (stored.model === SCHEMA_SEED_IDENTITY.model && stored.dimensions === SCHEMA_SEED_IDENTITY.dimensions);
  if (!embedded && seeded) return null;
  const configured = Number(await engine.getConfig('embedding_dimensions').catch(() => null) ?? NaN);
  const agrees = stored?.model && (!Number.isFinite(configured) || configured === stored.dimensions);
  return agrees ? { model: stored!.model!, dimensions: stored!.dimensions } : {};
}

/** The notice init prints instead of the deferred-setup hint when it kept the database's identity. */
export function keptEmbeddingNotice(kept: KeptEmbedding): string {
  if (!kept.model) return '  Embedding: this database already holds vectors whose model could not be confirmed, so init left embedding settings unchanged instead of disabling them. Run gbrain migrate embeddings --status, then gbrain doctor --only embedding_plane_disagreement --json.';
  let key = 'the provider API key';
  try { key = resolveRecipe(kept.model.includes(':') ? kept.model : `openai:${kept.model}`).recipe.auth_env?.required?.[0] ?? key; } catch { /* unknown provider: generic wording */ }
  return `  Embedding: kept this database's ${kept.model} (${kept.dimensions}d) instead of disabling embeddings; no provider key was found. Set ${key}, then run gbrain embed --stale to embed pages written meanwhile.`;
}
