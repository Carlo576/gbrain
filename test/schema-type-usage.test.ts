/**
 * Alias-footgun visibility (issue 3 of the five-issue fix wave).
 *
 * gbrain stores explicit frontmatter types literally and never re-normalizes
 * them, so a type that is an ALIAS of a canonical pack type (or undeclared
 * entirely) routes silently. These tests pin the mechanism that makes it loud:
 * classifyStoredType, the import-time type_warning field, the aggregated
 * sync/import summary renderer, and the data-plane schema lint rules.
 *
 * Privacy rule: fixtures use generic type names only.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  classifyStoredType,
  sanitizeTypeForDisplay,
  renderTypeWarningSummary,
  type TypeUsagePack,
} from '../src/core/schema-pack/type-usage.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const PACK: TypeUsagePack = {
  page_types: [
    { name: 'event', path_prefixes: ['events/'], aliases: ['happening', 'occasion'] },
    { name: 'note', path_prefixes: ['notes/'], aliases: [] },
    { name: 'isolated', path_prefixes: [] },
  ],
};

const MAPPING_PACK = {
  name: 'test-research-pack',
  version: '1.0.0',
  ...PACK,
  mapping_rules: [
    {
      kind: 'retype',
      from_type: 'happening',
      to_type: 'event',
      subtype: 'happening',
      subtype_field: 'legacy_type',
    },
  ],
};

describe('classifyStoredType', () => {
  test('canonical page_type name → canonical', () => {
    expect(classifyStoredType('event', PACK)).toEqual({ kind: 'canonical' });
  });

  test('alias → alias_of with canonical + filing directory', () => {
    expect(classifyStoredType('happening', PACK)).toEqual({
      kind: 'alias_of',
      canonical: 'event',
      directory: 'events/',
    });
  });

  test('alias of a type with no path_prefixes → directory undefined', () => {
    const pack: TypeUsagePack = {
      page_types: [{ name: 'isolated', path_prefixes: [], aliases: ['loner'] }],
    };
    const cls = classifyStoredType('loner', pack);
    expect(cls.kind).toBe('alias_of');
    expect((cls as { directory?: string }).directory).toBeUndefined();
  });

  test('undeclared type → undeclared', () => {
    expect(classifyStoredType('mystery', PACK)).toEqual({ kind: 'undeclared' });
  });

  test('canonical wins over alias when a name is both (shadowing pack)', () => {
    const shadowed: TypeUsagePack = {
      page_types: [
        { name: 'event', path_prefixes: ['events/'], aliases: [] },
        { name: 'note', path_prefixes: ['notes/'], aliases: ['event'] },
      ],
    };
    expect(classifyStoredType('event', shadowed)).toEqual({ kind: 'canonical' });
  });
});

describe('sanitizeTypeForDisplay', () => {
  test('strips control characters (ANSI-escape hygiene)', () => {
    expect(sanitizeTypeForDisplay('ev\x1b[31mil')).toBe('ev[31mil');
    expect(sanitizeTypeForDisplay('a\x00b\x07c')).toBe('abc');
  });

  test('caps length at 64', () => {
    const long = 'x'.repeat(100);
    const out = sanitizeTypeForDisplay(long);
    expect(out.length).toBe(64);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('renderTypeWarningSummary', () => {
  test('one line per distinct type, alias line names canonical + directory', () => {
    const lines = renderTypeWarningSummary([
      { kind: 'alias_of', type: 'happening', canonical: 'event', directory: 'events/', count: 12 },
      { kind: 'undeclared', type: 'mystery', count: 3 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("'happening'");
    expect(lines[0]).toContain("'event'");
    expect(lines[0]).toContain('events/');
    expect(lines[0]).toContain('12 file(s)');
    expect(lines[1]).toContain("'mystery'");
    expect(lines[1]).toContain('not declared');
  });

  test('empty input → no lines', () => {
    expect(renderTypeWarningSummary([])).toHaveLength(0);
  });
});

describe('importFromContent type_warning (advisory, type stored literally)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  async function importWithType(slug: string, type: string | null, activePack?: TypeUsagePack) {
    const { importFromContent } = await import('../src/core/import-file.ts');
    const fm = type === null ? '' : `type: ${type}\n`;
    const md = `---\n${fm}title: T\n---\n\n# T\n\nBody ${Math.random().toString(36).slice(2)}.\n`;
    return importFromContent(engine, slug, md, {
      noEmbed: true,
      ...(activePack ? { activePack: activePack as never } : {}),
    });
  }

  test('explicit alias type → alias_of warning, type stored as-is', async () => {
    const r = await importWithType('notes/alias-page', 'happening', PACK);
    expect(r.status).toBe('imported');
    expect(r.type_warning).toEqual({
      kind: 'alias_of',
      type: 'happening',
      canonical: 'event',
      directory: 'events/',
    });
    const page = await engine.getPage('notes/alias-page');
    expect(page?.type).toBe('happening'); // stored literally — advisory only
  }, 30_000);

  test('an edited source file cannot undo a completed type-unification migration', async () => {
    await engine.putPage('notes/migrated-page', {
      type: 'event',
      title: 'T',
      compiled_truth: 'Old body.',
      timeline: '',
      frontmatter: {
        legacy_type: 'happening',
        type_projection_pack: 'test-research-pack@1.0.0',
        type_projection_original_type: 'happening',
      },
    });

    const r = await importWithType('notes/migrated-page', 'happening', MAPPING_PACK as never);
    const page = await engine.getPage('notes/migrated-page');

    expect(r.status).toBe('imported');
    expect(page?.type).toBe('event');
    expect(page?.frontmatter.legacy_type).toBe('happening');
    expect(r.type_warning).toBeUndefined();
  }, 30_000);

  test('a completed type-unification subtype survives a later source edit', async () => {
    await engine.putPage('notes/migrated-subtype-page', {
      type: 'event',
      title: 'T',
      compiled_truth: 'Old body.',
      timeline: '',
      frontmatter: {
        legacy_type: 'happening',
        subtype: 'single',
        type_projection_pack: 'test-research-pack@1.0.0',
        type_projection_original_type: 'happening',
      },
    });

    await importWithType('notes/migrated-subtype-page', 'happening', MAPPING_PACK as never);
    const page = await engine.getPage('notes/migrated-subtype-page');

    expect(page?.type).toBe('event');
    expect(page?.frontmatter.legacy_type).toBe('happening');
    expect(page?.frontmatter.subtype).toBe('single');
  }, 30_000);

  test('legacy_type alone is not accepted as a type-projection receipt', async () => {
    await engine.putPage('notes/unmarked-legacy-page', {
      type: 'event', title: 'T', compiled_truth: 'Old body.', timeline: '',
      frontmatter: { legacy_type: 'happening' },
    });

    await importWithType('notes/unmarked-legacy-page', 'happening', PACK);
    expect((await engine.getPage('notes/unmarked-legacy-page'))?.type).toBe('happening');
  }, 30_000);

  test('a mapping-proven legacy_type receipt upgrades to the structured receipt', async () => {
    await engine.putPage('notes/base-unifier-page', {
      type: 'event', title: 'T', compiled_truth: 'Old body.', timeline: '',
      frontmatter: { legacy_type: 'happening' },
    });

    await importWithType('notes/base-unifier-page', 'happening', MAPPING_PACK as never);
    const page = await engine.getPage('notes/base-unifier-page');
    expect(page?.type).toBe('event');
    expect(page?.frontmatter.type_projection_pack).toBe('test-research-pack@1.0.0');
    expect(page?.frontmatter.type_projection_original_type).toBe('happening');
  }, 30_000);

  test('a forged receipt cannot preserve a type that contradicts the active mapping', async () => {
    await engine.putPage('notes/forged-projection-page', {
      type: 'company', title: 'T', compiled_truth: 'Old body.', timeline: '',
      frontmatter: {
        legacy_type: 'happening',
        type_projection_pack: 'test-research-pack@1.0.0',
        type_projection_original_type: 'happening',
      },
    });

    await importWithType('notes/forged-projection-page', 'happening', MAPPING_PACK as never);
    const page = await engine.getPage('notes/forged-projection-page');
    expect(page?.type).toBe('event');
    expect(page?.frontmatter.type_projection_pack).toBe('test-research-pack@1.0.0');
  }, 30_000);

  test('a migration committed after the initial read cannot be overwritten by import', async () => {
    await engine.putPage('notes/racing-projection-page', {
      type: 'happening', title: 'T', compiled_truth: 'Old body.', timeline: '', frontmatter: {},
    });
    const originalTransaction = engine.transaction.bind(engine);
    let injected = false;
    engine.transaction = (async (fn: Parameters<typeof engine.transaction>[0]) => {
      if (!injected) {
        injected = true;
        await engine.putPage('notes/racing-projection-page', {
          type: 'event', title: 'T', compiled_truth: 'Old body.', timeline: '',
          frontmatter: {
            legacy_type: 'happening',
            type_projection_pack: 'test-research-pack@1.0.0',
            type_projection_original_type: 'happening',
          },
        });
      }
      return originalTransaction(fn);
    }) as typeof engine.transaction;
    try {
      await importWithType('notes/racing-projection-page', null, MAPPING_PACK as never);
    } finally {
      engine.transaction = originalTransaction as typeof engine.transaction;
    }
    expect((await engine.getPage('notes/racing-projection-page'))?.type).toBe('event');
  }, 30_000);

  test('a mapping-aware pack canonicalizes a new explicit legacy type', async () => {
    const r = await importWithType('notes/new-mapped-page', 'happening', MAPPING_PACK as never);
    const page = await engine.getPage('notes/new-mapped-page');

    expect(page?.type).toBe('event');
    expect(page?.frontmatter.legacy_type).toBe('happening');
    expect(page?.frontmatter.type_projection_pack).toBe('test-research-pack@1.0.0');
    expect(page?.frontmatter.type_projection_original_type).toBe('happening');
    expect(r.type_warning).toBeUndefined();
  }, 30_000);

  test('implicit source type preserves a structured projection receipt', async () => {
    await engine.putPage('notes/implicit-projected-page', {
      type: 'event', title: 'T', compiled_truth: 'Old body.', timeline: '',
      frontmatter: {
        legacy_type: 'happening',
        type_projection_pack: 'test-research-pack@1.0.0',
        type_projection_original_type: 'happening',
      },
    });

    await importWithType('notes/implicit-projected-page', null, MAPPING_PACK as never);
    const page = await engine.getPage('notes/implicit-projected-page');
    expect(page?.type).toBe('event');
    expect(page?.frontmatter.legacy_type).toBe('happening');
  }, 30_000);

  test('explicit canonical source type preserves a structured projection receipt', async () => {
    await engine.putPage('notes/canonical-projected-page', {
      type: 'event', title: 'T', compiled_truth: 'Old body.', timeline: '',
      frontmatter: {
        legacy_type: 'happening',
        type_projection_pack: 'test-research-pack@1.0.0',
        type_projection_original_type: 'happening',
      },
    });

    await importWithType('notes/canonical-projected-page', 'event', MAPPING_PACK as never);
    const page = await engine.getPage('notes/canonical-projected-page');
    expect(page?.type).toBe('event');
    expect(page?.frontmatter.legacy_type).toBe('happening');
  }, 30_000);

  test('an intentional third explicit type supersedes a structured projection receipt', async () => {
    await engine.putPage('notes/retyped-projected-page', {
      type: 'event', title: 'T', compiled_truth: 'Old body.', timeline: '',
      frontmatter: {
        legacy_type: 'happening',
        type_projection_pack: 'test-research-pack@1.0.0',
        type_projection_original_type: 'happening',
      },
    });

    await importWithType('notes/retyped-projected-page', 'mystery', MAPPING_PACK as never);
    const page = await engine.getPage('notes/retyped-projected-page');
    expect(page?.type).toBe('mystery');
    expect(page?.frontmatter.type_projection_pack).toBeUndefined();
  }, 30_000);

  test('explicit undeclared type → undeclared warning', async () => {
    const r = await importWithType('notes/mystery-page', 'mystery', PACK);
    expect(r.type_warning).toEqual({ kind: 'undeclared', type: 'mystery' });
  }, 30_000);

  test('explicit canonical type → no warning', async () => {
    const r = await importWithType('notes/canonical-page', 'event', PACK);
    expect(r.type_warning).toBeUndefined();
  }, 30_000);

  test('no activePack → no warning (classification skipped)', async () => {
    const r = await importWithType('notes/packless-page', 'happening');
    expect(r.type_warning).toBeUndefined();
  }, 30_000);

  test('no explicit type (typeExplicit false) → no warning', async () => {
    const r = await importWithType('notes/implicit-page', null, PACK);
    expect(r.type_warning).toBeUndefined();
  }, 30_000);
});

describe('schema lint data-plane rules: stored_type_is_alias / stored_type_undeclared', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('events/party', {
      type: 'happening', title: 'P', compiled_truth: 'x', timeline: '', frontmatter: {},
    });
    await engine.putPage('notes/odd', {
      type: 'mystery', title: 'M', compiled_truth: 'x', timeline: '', frontmatter: {},
    });
    await engine.putPage('events/legit', {
      type: 'event', title: 'E', compiled_truth: 'x', timeline: '', frontmatter: {},
    });
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  const manifest = {
    name: 'test-pack',
    page_types: [
      { name: 'event', path_prefixes: ['events/'], aliases: ['happening'] },
      { name: 'note', path_prefixes: ['notes/'], aliases: [] },
    ],
  } as never;

  test('alias-typed corpus rows surface as stored_type_is_alias warnings', async () => {
    const { storedTypeIsAlias } = await import('../src/core/schema-pack/lint-rules.ts');
    const issues = await storedTypeIsAlias(manifest, { engine });
    const hit = issues.find(i => i.type === 'happening');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.message).toContain("alias of 'event'");
  }, 30_000);

  test('undeclared-typed corpus rows surface as stored_type_undeclared warnings', async () => {
    const { storedTypeUndeclared } = await import('../src/core/schema-pack/lint-rules.ts');
    const issues = await storedTypeUndeclared(manifest, { engine });
    const hit = issues.find(i => i.type === 'mystery');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    // canonical + alias types must NOT be flagged
    expect(issues.find(i => i.type === 'event')).toBeUndefined();
    expect(issues.find(i => i.type === 'happening')).toBeUndefined();
  }, 30_000);

  test('rules are engine-gated: no engine → no issues', async () => {
    const { storedTypeIsAlias, storedTypeUndeclared } = await import('../src/core/schema-pack/lint-rules.ts');
    expect(await storedTypeIsAlias(manifest, {})).toHaveLength(0);
    expect(await storedTypeUndeclared(manifest, {})).toHaveLength(0);
  });
});
