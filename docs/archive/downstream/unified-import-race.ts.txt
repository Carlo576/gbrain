import type { BrainEngine } from '../engine.ts';
import type { PageInput, PageType } from '../types.ts';
import { contentHash } from '../utils.ts';
import { resolveUnifiedImportType, type ProjectionAwareTypePack } from './unified-import-type.ts';

interface ReconcileInput {
  tx: BrainEngine;
  sourceId: string;
  slug: string;
  initial: { type: PageType; content_hash?: string | null };
  parsed: { type: PageType; typeExplicit: boolean; frontmatter: Record<string, unknown> };
  page: Pick<PageInput, 'title' | 'compiled_truth' | 'timeline' | 'tags'>;
  activePack?: ProjectionAwareTypePack;
}

/** Lock and re-resolve metadata when migration won the read-to-write race. */
export async function reconcileUnifiedImportRace(input: ReconcileInput): Promise<{
  type: PageType; frontmatter: Record<string, unknown>; content_hash: string;
} | null> {
  const [locked] = await input.tx.executeRaw<{
    type: PageType; frontmatter: Record<string, unknown>; content_hash: string | null;
  }>(
    `SELECT type, frontmatter, content_hash FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
    [input.sourceId, input.slug],
  );
  if (!locked || (locked.type === input.initial.type && locked.content_hash === input.initial.content_hash)) return null;
  const resolved = resolveUnifiedImportType({
    parsedType: input.parsed.type, typeExplicit: input.parsed.typeExplicit,
    parsedFrontmatter: input.parsed.frontmatter, activePack: input.activePack, existing: locked,
  });
  return {
    type: resolved.type,
    frontmatter: resolved.frontmatter,
    content_hash: contentHash({ ...input.page, type: resolved.type, frontmatter: resolved.frontmatter }),
  };
}
