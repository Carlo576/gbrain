import { expandTypeFilter, type ExpandedTypeFilter } from './expand-type-filter.ts';
import type { BrainEngine } from '../engine.ts';
import { expandClosure } from './closure.ts';
import { engineSchemaInput } from './engine-resolution.ts';
import { loadActivePack, resolveActivePackNameOnly } from './load-active.ts';
import { SchemaPackTrustGateError } from './op-trust-gate.ts';

export async function expandEngineTypeFilters(
  engine: Pick<BrainEngine, 'getConfig'> & Partial<Pick<BrainEngine, 'executeRaw'>>,
  options: { type?: string; types?: string[]; sourceId?: string; sourceIds?: string[]; remote?: boolean; expandedTypes?: ExpandedTypeFilter[] },
): Promise<{ type?: undefined; types?: string[]; expandedTypes?: ExpandedTypeFilter[] }> {
  if (options.expandedTypes?.length) return { type: undefined, types: undefined, expandedTypes: options.expandedTypes };
  if (options.types?.length === 0) return { type: undefined, types: [] };
  if (!options.type && !options.types?.length) return {};
  let sourceIds: Array<string | undefined> = options.sourceIds?.length ? options.sourceIds : [options.sourceId];
  if (options.remote === false && (!options.sourceId || options.sourceId === '__all__') && !options.sourceIds?.length && engine.executeRaw) {
    const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE');
    if (sources.length) sourceIds = sources.map(source => source.id);
  }
  const inputs = await Promise.all(sourceIds.map(sourceId => engineSchemaInput(engine, { remote: options.remote !== false, sourceId })));
  const names = new Set(inputs.map(input => resolveActivePackNameOnly(input).pack_name));
  if (names.size > 1) {
    throw new SchemaPackTrustGateError('Type-filtered reads across sources with divergent schema packs are not supported. Query one source at a time.');
  }
  let pack;
  try {
    pack = await loadActivePack(inputs[0]);
  } catch {
    return { type: undefined, types: [] };
  }
  // Keep pre-unification callers source-scoped while matching the exact
  // canonical subtype/legacy receipt, rather than all pages of its new type.
  if (!options.type && options.types?.length) {
    const expandedTypes = options.types.map(type => expandTypeFilter(type, pack.manifest));
    if (expandedTypes.some(filter => filter.isAliasExpansion)) {
      return { type: undefined, types: undefined, expandedTypes };
    }
  }
  const scalar = options.type ? expandClosure(options.type, pack.alias_graph) : undefined;
  const multiple = options.types?.length
    ? [...new Set(options.types.flatMap(type => expandClosure(type, pack.alias_graph)))]
    : undefined;
  return { type: undefined, types: (scalar && multiple ? scalar.filter(type => multiple.includes(type)) : scalar ?? multiple)?.sort() };
}
