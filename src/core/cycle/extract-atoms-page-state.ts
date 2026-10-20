import type { SqlEngine } from '../persistence/model.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { stableJson } from '../persistence/digest.ts';
import type { BrainEngine } from '../engine.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import type { PageEmbedGrant } from '../page-embedding-budget.ts';

/**
 * gbrain#4148: consecutive same-content failures of a content-deterministic
 * class (malformed model output or provider content block) before the page is tombstoned so the
 * backlog floor can clear. A content edit resets the streak. #6325: a managed
 * page or transcript settles held_failed at the same bound.
 */
export const MAX_DETERMINISTIC_FAILURES = 3;

export interface AtomPageIdentity {
  pageId: number;
  sourceIncarnation: string;
  revision: string;
}

export interface AtomPageInput {
  slug: string;
  content: string;
  contentHash: string;
  identity?: AtomPageIdentity;
  /** Discovery found a segmented page: `content` is empty until extract-atoms-segments.ts expands it into windows. */
  segmented?: boolean;
  /** PR 4 4b: `content` is one window of a segmented page's occurrence, not the page. */
  window?: AtomPageWindow;
}

// PR 4 (Wave B incremental derivation, transcripts)
/** One window of a segmented page (extract-atoms-segments.ts); its methods are bound to the page's derivation plan. */
export interface AtomPageWindow {
  /** Reserve this window's model call against the page's spend cap. Null: refused, the page's remaining windows are skipped and the receipt recorded. */
  reserve(model: string, maxOutputTokens: number): Promise<{ grant?: Pick<PageEmbedGrant, 'settle'> } | null>;
  /** Record the window extracted with these atoms. Returns the atom slugs retired when this settles the page. */
  settle(atomSlugs: string[]): Promise<string[]>;
}

export class AtomPageStateError extends Error {
  constructor(reason: 'changed' | 'unpinned' | 'schema' | 'denied' | 'storage') {
    super({
      changed: 'atom page changed during extraction; scan state was not saved and the page remains retryable',
      unpinned: 'atom page state was not pinned before extraction; page remains retryable',
      schema: 'atom page scan state is unavailable (42P01); check schema migrations. The page remains retryable',
      denied: 'atom page scan state write was denied (42501); check database permissions. The page remains retryable',
      storage: 'atom page scan state could not be saved; check database access and schema migrations. The page remains retryable',
    }[reason]);
    this.name = 'AtomPageStateError';
  }
}

export async function readAtomPageIdentity(engine: SqlEngine, sourceId: string, item: AtomPageInput): Promise<AtomPageIdentity | undefined> {
  const [row] = await engine.executeRaw<{ id: number; incarnation: string; knowledge_revision: string }>(
    `SELECT p.id, s.incarnation, p.knowledge_revision FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.source_id=$1 AND p.slug=$2 AND p.content_hash=$3 AND p.deleted_at IS NULL`,
    [sourceId, item.slug, item.contentHash]);
  return row && { pageId: row.id, sourceIncarnation: row.incarnation, revision: row.knowledge_revision };
}

export async function writeAtomPageState(
  engine: SqlEngine, sourceId: string, item: AtomPageInput, outcome: 'complete' | 'failure',
): Promise<number> {
  if (!item.identity) throw new AtomPageStateError('unpinned');
  const { pageId, sourceIncarnation, revision } = item.identity;
  const [row] = await engine.executeRaw<{ fail_count: number }>(
    `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned)
      SELECT s.incarnation, p.id, p.content_hash, $7::integer, $8::boolean
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4
        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET fail_count=extract_atoms_page_state.fail_count + EXCLUDED.fail_count,
            tombstoned=extract_atoms_page_state.tombstoned OR EXCLUDED.tombstoned, updated_at=now()
      RETURNING fail_count`,
    [pageId, sourceIncarnation, sourceId, item.slug, item.contentHash, revision,
      outcome === 'failure' ? 1 : 0, outcome === 'complete']).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new AtomPageStateError(code === '42P01' ? 'schema' : code === '42501' ? 'denied' : 'storage');
  });
  if (!row) throw new AtomPageStateError('changed');
  return Number(row.fail_count);
}

export async function completeAtomReceipts(
  engine: BrainEngine, sourceId: string, importedSlugs: string[], hash16: string, page?: AtomPageInput,
): Promise<void> {
  await maintenanceTransaction(engine, async tx => {
    const completed = await tx.executeRaw(
      `UPDATE pages
          SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
        WHERE source_id = $2 AND type = 'atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL
          ${page ? `AND EXISTS (
            SELECT 1 FROM pages origin JOIN sources s ON s.id=origin.source_id
            WHERE origin.id=$4 AND s.incarnation=$5::uuid AND origin.source_id=$2
              AND origin.content_hash=$6 AND origin.knowledge_revision=$7::uuid AND origin.deleted_at IS NULL
            FOR SHARE OF origin, s
          )` : ''}
        RETURNING slug`,
      page
        ? [hash16, sourceId, importedSlugs, page.identity?.pageId ?? null,
          page.identity?.sourceIncarnation ?? null, page.contentHash, page.identity?.revision ?? null]
        : [hash16, sourceId, importedSlugs],
    );
    if (completed.length !== new Set(importedSlugs).size) {
      throw new Error('atom completion could not be saved because the source or atom pages changed; pending atoms remain retryable');
    }
  });
}

const LEGACY_KEYS = ['atoms_scan_hash', 'atoms_fail_hash', 'atoms_fail_count'];

export function matchingLegacyAtomPageState(frontmatter: Record<string, unknown>, contentHash: string): { fail_count: number; tombstoned: boolean } | null {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) return null;
  const hash = contentHash.slice(0, 16);
  const hasFailure = LEGACY_KEYS.slice(1).some(key => Object.hasOwn(frontmatter, key));
  const count = frontmatter.atoms_fail_count;
  if (hasFailure && (frontmatter.atoms_fail_hash !== hash || typeof count !== 'number'
    || !Number.isInteger(count) || count < 1 || count > 2147483647)) return null;
  if (Object.hasOwn(frontmatter, 'atoms_scan_hash') && frontmatter.atoms_scan_hash !== hash) return null;
  const tombstoned = frontmatter.atoms_scan_hash === hash;
  return tombstoned || hasFailure ? { fail_count: hasFailure ? count as number : 0, tombstoned } : null;
}

export async function transferLegacyAtomPageState(engine: SqlEngine, before: PageSnapshot, after: PageSnapshot): Promise<boolean> {
  if (before.page.id !== after.page.id || before.sourceIncarnation !== after.sourceIncarnation
    || !before.page.content_hash || !after.page.content_hash || before.page.deleted_at || after.page.deleted_at) return false;
  const canonical = (snapshot: PageSnapshot) => {
    const frontmatter = { ...snapshot.page.frontmatter };
    for (const key of LEGACY_KEYS) delete frontmatter[key];
    return { sourceId: snapshot.page.source_id, slug: snapshot.page.slug, type: snapshot.page.type,
      title: snapshot.page.title, body: snapshot.page.compiled_truth,
      timeline: snapshot.page.timeline, frontmatter, tags: [...snapshot.tags].sort(), withdrawals: snapshot.withdrawals,
      global_purges: snapshot.globalPurges ?? null };
  };
  if (stableJson(canonical(before)) !== stableJson(canonical(after))) return false;
  const [existing] = await engine.executeRaw<{ fail_count: number; tombstoned: boolean }>(
    `SELECT fail_count, tombstoned FROM extract_atoms_page_state
      WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash=$3`,
    [before.sourceIncarnation, before.page.id, before.page.content_hash]);
  const state = existing ?? matchingLegacyAtomPageState(before.page.frontmatter, before.page.content_hash);
  if (!state) return false;
  const rows = await engine.executeRaw(
    `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned)
      SELECT s.incarnation, p.id, p.content_hash, $5::integer, $6::boolean
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.content_hash=$3 AND p.knowledge_revision=$4::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET fail_count=GREATEST(extract_atoms_page_state.fail_count, EXCLUDED.fail_count),
            tombstoned=extract_atoms_page_state.tombstoned OR EXCLUDED.tombstoned, updated_at=now()
      RETURNING page_id`,
    [after.page.id, after.sourceIncarnation, after.page.content_hash, after.revision, state.fail_count, state.tombstoned]);
  return rows.length > 0;
}

/**
 * Soft-delete a source's atoms from earlier extractions (a different or
 * provisional source_hash) that the current, completed extraction did not
 * re-produce. Imported atoms (`imported_from`) and managed atoms are left
 * alone. Best-effort: a failure leaves duplicates, never loses current atoms.
 */
export async function retireStaleAtoms(
  engine: BrainEngine,
  sourceId: string,
  origin: { key: 'source_slug' | 'source_path'; value: string },
  hash16: string,
  currentSlugs: string[],
): Promise<string[]> {
  try {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND type = 'atom' AND deleted_at IS NULL
          AND frontmatter->>'${origin.key}' = $2
          AND COALESCE(frontmatter->>'source_hash', '') <> $3
          AND (frontmatter->>'imported_from') IS NULL
          AND COALESCE(frontmatter->>'managed_extraction', '') <> 'true'
          AND NOT (slug = ANY($4::text[]))`,
      [sourceId, origin.value, hash16, currentSlugs],
    );
    const stale = rows.map(r => r.slug);
    for (let i = 0; i < stale.length; i += 500) await maintenanceTransaction(engine, tx => tx.softDeletePages(stale.slice(i, i + 500), { sourceId }));
    return stale;
  } catch (err) {
    console.error(`[extract_atoms] stale atom cleanup failed for ${origin.value} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
