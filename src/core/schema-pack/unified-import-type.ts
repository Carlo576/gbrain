// Canonicalize explicit legacy labels and preserve structured type-projection
// receipts across later source-file imports.

export const TYPE_PROJECTION_PACK_KEY = 'type_projection_pack';
export const TYPE_PROJECTION_ORIGINAL_KEY = 'type_projection_original_type';

interface RetypeMappingRule {
  kind?: unknown;
  from_type?: unknown;
  to_type?: unknown;
  subtype?: unknown;
  subtype_field?: unknown;
  path_filter?: unknown;
  slug_filter?: unknown;
}

export interface ProjectionAwareTypePack {
  name?: string;
  version?: string;
  page_types: ReadonlyArray<{
    name: string;
    path_prefixes: ReadonlyArray<string>;
    aliases?: ReadonlyArray<string>;
  }>;
  mapping_rules?: ReadonlyArray<RetypeMappingRule>;
}

export interface UnifiedImportTypeInput<T extends string> {
  parsedType: T;
  typeExplicit: boolean;
  parsedFrontmatter: Record<string, unknown>;
  activePack?: ProjectionAwareTypePack;
  existing?: { type: T; frontmatter?: Record<string, unknown> | null } | null;
}

export interface UnifiedImportTypeResult<T extends string> {
  type: T;
  frontmatter: Record<string, unknown>;
  preservedUnifiedType: boolean;
}

function validReceipt(
  frontmatter: Record<string, unknown> | null | undefined,
  existingType: string,
  pack: ProjectionAwareTypePack | undefined,
): boolean {
  const legacy = frontmatter?.legacy_type;
  const original = frontmatter?.[TYPE_PROJECTION_ORIGINAL_KEY];
  const receiptPack = frontmatter?.[TYPE_PROJECTION_PACK_KEY];
  if (
    typeof legacy !== 'string' || original !== legacy ||
    !pack?.name || !pack.version || receiptPack !== `${pack.name}@${pack.version}`
  ) return false;
  return resolveRetypeRule(legacy, pack)?.to_type === existingType;
}

function mergeReceipt(
  parsed: Record<string, unknown>,
  existing: Record<string, unknown>,
  pack: ProjectionAwareTypePack,
): Record<string, unknown> {
  const merged = { ...parsed };
  const legacy = existing.legacy_type;
  merged.legacy_type = legacy;
  merged[TYPE_PROJECTION_PACK_KEY] = typeof existing[TYPE_PROJECTION_PACK_KEY] === 'string'
    ? existing[TYPE_PROJECTION_PACK_KEY]
    : `${pack.name}@${pack.version}`;
  merged[TYPE_PROJECTION_ORIGINAL_KEY] = typeof existing[TYPE_PROJECTION_ORIGINAL_KEY] === 'string'
    ? existing[TYPE_PROJECTION_ORIGINAL_KEY]
    : legacy;
  if (merged.subtype === undefined && typeof existing.subtype === 'string') {
    merged.subtype = existing.subtype;
  }
  return merged;
}

function resolveRetypeRule(type: string, pack: ProjectionAwareTypePack | undefined): RetypeMappingRule | null {
  if (!pack || pack.page_types.some((pt) => pt.name === type)) return null;
  const rules = pack.mapping_rules?.filter((rule) => rule.kind === 'retype') ?? [];
  const explicit = rules.find((rule) => rule.from_type === type && !rule.path_filter && !rule.slug_filter);
  const rule = explicit ?? rules.find((candidate) => candidate.from_type === '*unknown*');
  if (!rule || typeof rule.to_type !== 'string') return null;
  if (!pack.page_types.some((pt) => pt.name === rule.to_type)) return null;
  return rule;
}

function canonicalizeFromPack<T extends string>(
  input: UnifiedImportTypeInput<T>,
): UnifiedImportTypeResult<T> | null {
  if (!input.typeExplicit) return null;
  const rule = resolveRetypeRule(input.parsedType, input.activePack);
  if (!rule || typeof rule.to_type !== 'string') return null;
  const frontmatter: Record<string, unknown> = {
    ...input.parsedFrontmatter,
    legacy_type: input.parsedType,
    [TYPE_PROJECTION_ORIGINAL_KEY]: input.parsedType,
    [TYPE_PROJECTION_PACK_KEY]: `${input.activePack?.name ?? 'schema-pack'}@${input.activePack?.version ?? 'unknown'}`,
  };
  if (typeof rule.subtype === 'string' && rule.subtype !== '*original_type*') {
    const field = typeof rule.subtype_field === 'string' ? rule.subtype_field : 'subtype';
    frontmatter[field] = rule.subtype;
  }
  return { type: rule.to_type as T, frontmatter, preservedUnifiedType: true };
}

export function resolveUnifiedImportType<T extends string>(
  input: UnifiedImportTypeInput<T>,
): UnifiedImportTypeResult<T> {
  const existingFrontmatter = input.existing?.frontmatter ?? undefined;
  const legacy = existingFrontmatter?.legacy_type;
  const mappingMatchesExisting =
    input.existing && input.activePack && typeof legacy === 'string' &&
    resolveRetypeRule(legacy, input.activePack)?.to_type === input.existing.type;
  if (
    input.existing && input.activePack &&
    (validReceipt(existingFrontmatter, input.existing.type, input.activePack) || mappingMatchesExisting)
  ) {
    const original = existingFrontmatter?.[TYPE_PROJECTION_ORIGINAL_KEY];
    const preservesReceipt =
      !input.typeExplicit || input.parsedType === input.existing.type ||
      input.parsedType === original || input.parsedType === legacy;
    if (preservesReceipt) {
      return {
        type: input.existing.type,
        frontmatter: mergeReceipt(input.parsedFrontmatter, existingFrontmatter!, input.activePack),
        preservedUnifiedType: true,
      };
    }
  }
  const canonicalized = canonicalizeFromPack(input);
  if (canonicalized) return canonicalized;
  if (!input.typeExplicit && input.existing) {
    return { type: input.existing.type, frontmatter: input.parsedFrontmatter, preservedUnifiedType: false };
  }
  return { type: input.parsedType, frontmatter: input.parsedFrontmatter, preservedUnifiedType: false };
}
