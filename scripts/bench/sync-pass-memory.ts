#!/usr/bin/env bun
/**
 * Probe: memory of the managed sync pass on a large source (#7644, #7596).
 *
 *   bun scripts/bench/sync-pass-memory.ts seed --url <admin pg url> --dir <dir> [--pages 20000] [--ahead 5000] [--commits 2000] [--dbonly 2000]
 *   bun scripts/bench/sync-pass-memory.ts run  --url <admin pg url> --dir <dir> [--mode convert|sync] [--extract] [--full] [--strict]
 *   bun scripts/bench/sync-pass-memory.ts cli  ... [--mode convert|sync] [--embed] [--extract] [--full] [--kill-after <s>] [--db-url <pooler url>]
 *   bun scripts/bench/sync-pass-memory.ts embed-seed ...   (embeds the template's pages through the stub, as a brain that already has vectors)
 *   (--tag <name> names the template and run databases, so several seeds can live side by side)
 * cli runs the real gbrain CLI as a child (GBRAIN_MEMORY_TRACE on, embeddings through a loopback stub with --embed) and
 * samples its RSS from /proc once a second.
 *
 * seed builds a managed Postgres brain whose default source holds --pages committed files written over --commits commits
 * (with renames and rewrites, then git gc), first-syncs it, makes --ahead of its pages database_ahead with no import
 * record (the row changes only type, frontmatter.legacy_type and frontmatter.subtype), adds --dbonly database-only pages,
 * and keeps the result as a template database. run clones the template, resets the checkout to the seeded commit and runs
 * the conversion apply (convert) or a plain full sync (sync), sampling RSS and heap once a second.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { DEFAULTS, pageContent, pagePath, planSource } from './production-soak/fixture.ts';
import { startEmbeddingStub } from './managed-sync-catchup-lib.ts';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1]! : fallback; };
const command = args[0];
const adminUrl = flag('url', 'postgresql://postgres:postgres@127.0.0.1:5434/postgres')!;
const dir = flag('dir')!;
const PAGES = Number(flag('pages', '20000')), AHEAD = Number(flag('ahead', '5000')), COMMITS = Number(flag('commits', '200')), DBONLY = Number(flag('dbonly', '0'));
const KB = Number(flag('kb', '1')), LEGACY = Number(flag('legacy', '0')), FIXTURE = args.includes('--fixture'), EXTRACT = args.includes('--extract');
// --fixture: the production-soak fixture's pages (links, facts fences, timelines, private pages, long meetings and chats), its default source.
const soak = { ...DEFAULTS, pages: Math.ceil(PAGES / 0.52) + 1, hugeMb: 1, oversized: 0 };
const soakPlan = FIXTURE ? planSource(soak, 0) : null;
if (soakPlan && soakPlan.lives < PAGES) throw new Error(`the fixture plan has ${soakPlan.lives} pages, fewer than --pages`);
const tag = (flag('tag', 'probe') ?? 'probe').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
const SEED_DB = `gbrain_${tag}_seed`, RUN_DB = `gbrain_${tag}_run`;
const home = join(dir, 'home'), root = join(home, 'content');
process.env.GBRAIN_HOME = home;
delete process.env.DATABASE_URL; delete process.env.GBRAIN_DATABASE_URL;

const git = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
const dbUrl = (name: string) => { const u = new URL(adminUrl); u.pathname = '/' + name; return u.toString(); };
const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
const body = (i: number, v = 0) => Array.from({ length: Math.round((30 + (i % 40)) * KB * 1.5) }, (_, k) => (k % 12 === 11 ? '\n\n' : '') + WORDS[(i * 7 + k * 13 + v) % WORDS.length]).join(' ');
const slugOf = (i: number) => 'notes/d' + String(i % 50).padStart(2, '0') + '/p' + String(i).padStart(6, '0');
const file = (i: number, v = 0) => '---\ntype: note\ntitle: Page ' + i + '\n---\n\n# Page ' + i + '\n\n' + body(i, v) + '\n\n' + body(i + 1, v) + '\n';
const pathOf = (i: number) => soakPlan ? pagePath(soak, soakPlan, i, 0) : slugOf(i) + '.md';
const contentOf = (i: number, v = 0) => soakPlan ? pageContent(soak, soakPlan, i, v) : file(i, v);
const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

async function open(name: string): Promise<PostgresEngine> {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: dbUrl(name), poolSize: 4 });
  return engine;
}

async function seed(): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe('DROP DATABASE IF EXISTS ' + RUN_DB + ' WITH (FORCE)');
  await admin.unsafe('DROP DATABASE IF EXISTS ' + SEED_DB + ' WITH (FORCE)');
  await admin.unsafe('CREATE DATABASE ' + SEED_DB);
  rmSync(home, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
  git('init', '-q'); git('config', 'user.name', 'Example Writer'); git('config', 'user.email', 'writer@example.invalid'); git('config', 'gc.auto', '0');
  // History: the pages arrive over COMMITS commits; along the way some are rewritten and some renamed (moved, then back).
  const perCommit = Math.ceil(PAGES / COMMITS);
  for (let c = 0; c < COMMITS; c++) {
    for (let i = c * perCommit; i < Math.min(PAGES, (c + 1) * perCommit); i++) write(pathOf(i), contentOf(i));
    if (c > 2) for (let k = 0; k < 5; k++) { const i = (c * 31 + k * 97) % (c * perCommit); write(pathOf(i), contentOf(i, c)); }
    if (c > 4 && c % 3 === 0) { const i = (c * 53) % (c * perCommit); const from = join(root, pathOf(i)), to = join(root, 'archive', pathOf(i));
      if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); } }
    if (c > 6 && c % 3 === 1) { const i = (((c - 1) * 53) % ((c - 1) * perCommit)); const from = join(root, 'archive', pathOf(i)), to = join(root, pathOf(i));
      if (existsSync(from)) renameSync(from, to); }
    git('add', '-A'); git('commit', '-qm', 'batch ' + c);
  }
  git('gc', '-q');
  const engine = await open(SEED_DB);
  try {
    await engine.initSchema();
    const { claimWorktree } = await import('../../src/core/persistence/ownership.ts');
    const { activateSharedSkillPersistence } = await import('../../src/core/persistence/skill-activation.ts');
    const { performManagedSync } = await import('../../src/core/persistence/sync-run.ts');
    const { withCoordinatedWrite } = await import('../../src/core/persistence/context.ts');
    const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    const started = performance.now();
    const first = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
    console.error('first sync ' + first.status + ' in ' + Math.round((performance.now() - started) / 1000) + 's');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      const ids = await tx.executeRaw<{ id: string }>("UPDATE pages SET type='concept', frontmatter=frontmatter || jsonb_build_object('type','concept','legacy_type',type,'subtype','imported'), "
        + "knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default' AND id IN (SELECT id FROM pages WHERE source_id='default' ORDER BY slug LIMIT $1) RETURNING id::text", [AHEAD]);
      await tx.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance' AND split_part(fingerprint, ':', 3) = ANY($1::text[])", [ids.map(row => row.id)]);
      // Pages an older gbrain imported: equal to their files, with no import record.
      if (LEGACY) await tx.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance' AND split_part(fingerprint, ':', 3) IN (SELECT id::text FROM pages WHERE source_id='default' ORDER BY slug DESC LIMIT $1)", [LEGACY]);
      if (DBONLY) await tx.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,database_only_reason) "
        + "SELECT 'default','dbonly/p'||lpad(n::text,6,'0'),'note','Database page '||n,'Only in the database '||n||'.','',jsonb_build_object('type','note','title','Database page '||n),'db_only' "
        + "FROM generate_series(0,$1::int - 1) n", [DBONLY]);
    }, { requestId: null, principal: { kind: 'application', id: 'probe:fixture' } }));
    await disposePersistenceConsumer(engine);
  } finally { await engine.disconnect(); }
  writeFileSync(join(dir, 'seed.json'), JSON.stringify({ pages: PAGES, ahead: AHEAD, commits: COMMITS, dbonly: DBONLY, kb: KB, legacy: LEGACY, head: git('rev-parse', 'HEAD') }));
  await admin.end();
}

const mode = flag('mode', 'convert')!;
async function run(): Promise<void> {
  const seeded = JSON.parse(await Bun.file(join(dir, 'seed.json')).text()) as { head: string };
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe('DROP DATABASE IF EXISTS ' + RUN_DB + ' WITH (FORCE)');
  await admin.unsafe('CREATE DATABASE ' + RUN_DB + ' TEMPLATE ' + SEED_DB);
  await admin.end();
  git('reset', '-q', '--hard', seeded.head); git('clean', '-qfd');
  const out = flag('out', join(dir, 'samples-' + mode + '.ndjson'))!;
  writeFileSync(out, '');
  const t0 = performance.now();
  let phase = 'start', scanned = 0, total = 0, ticks = 0;
  const { heapStats } = await import('bun:jsc');
  const sample = () => {
    const m = process.memoryUsage();
    const types = ticks++ % 10 === 0 ? Object.fromEntries(Object.entries(heapStats().objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) : undefined;
    appendFileSync(out, JSON.stringify({ t: Math.round((performance.now() - t0) / 100) / 10, phase, scanned, total, rss_mb: Math.round(m.rss / 1048576), heap_mb: Math.round(m.heapUsed / 1048576), ...(types ? { types } : {}) }) + '\n');
  };
  const timer = setInterval(sample, 1000);
  const engine = await open(RUN_DB);
  try {
    const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
    const onProgress = (event: { phase: string; scanned?: number; total?: number; bankedFiles?: number; round?: unknown }) => { phase = typeof event.round === 'number' ? `${event.phase}:${event.round}` : event.phase; if (event.scanned !== undefined) scanned = event.scanned; else if (event.bankedFiles !== undefined) scanned = event.bankedFiles; if (event.total !== undefined) total = event.total; };
    if (mode === 'convert') {
      const { planGitConversion, applyGitConversion } = await import('../../src/core/persistence/git-conversion.ts');
      phase = 'plan';
      const { preview } = await planGitConversion(engine, 'default');
      console.error('plan: adopt ' + preview.adopt.count + ' discard ' + preview.discard.count + ' remaining ' + preview.remaining + ' hash ' + preview.preview_hash);
      phase = 'apply';
      const result = await applyGitConversion(engine, 'default', preview.preview_hash, { noEmbed: true, noExtract: !EXTRACT, onProgress } as never);
      console.error('apply: ' + result.status + ' groups ' + result.committed.groups + ' pages ' + result.committed.pages + ' remaining ' + result.after.remaining);
      writeFileSync(join(dir, 'result-' + mode + '.json'), JSON.stringify({ preview, result: { ...result, committed: { ...result.committed, commits: result.committed.commits.length } } }, null, 1));
    } else {
      const { performManagedSync } = await import('../../src/core/persistence/sync-run.ts');
      phase = 'sync';
      const { planGitConversion } = await import('../../src/core/persistence/git-conversion.ts');
      const { preview } = await planGitConversion(engine, 'default');
      console.error('plan: pages ' + preview.pages + ' equal ' + preview.equal + ' adopt ' + preview.adopt.count + ' declared ' + preview.declared.count + ' withhold ' + preview.withhold.count + ' discard ' + preview.discard.count);
      const result = await performManagedSync(engine, { sourceId: 'default', noPull: true, full: args.includes('--full'), noEmbed: true, noExtract: !EXTRACT, onProgress,
        ...(args.includes('--strict') ? { canonicalOverride: 'git' as const } : {}) } as never);
      console.error('sync: ' + result.status + ' ' + (result.reason ?? '') + ' added ' + result.added + ' modified ' + result.modified + ' deleted ' + result.deleted);
      writeFileSync(join(dir, 'result-' + mode + '.json'), JSON.stringify(result, null, 1));
    }
    await disposePersistenceConsumer(engine);
  } finally {
    clearInterval(timer); sample();
    await engine.disconnect();
  }
  console.error('done in ' + Math.round(performance.now() - t0) / 1000 + 's; samples in ' + out);
}


/** The gbrain config of a CLI run: the database, and embeddings through the stub (`--embed`) or off. */
function writeConfig(database: string, embed: boolean): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: flag('db-url', '') ? dbUrlAt(flag('db-url')!, database) : dbUrl(database),
    self_upgrade: { mode: 'off' }, ...(embed ? { embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1024 } : { embedding_disabled: true }) }, null, 2) + '\n');
}
const dbUrlAt = (base: string, name: string) => { const u = new URL(base); u.pathname = '/' + name; return u.toString(); };
const rssOf = (pid: number) => { try { const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(Number(m[1]) / 1024) : null; } catch { return null; } };

/** Runs the gbrain CLI with the run's home and the stub's environment, sampling its RSS once a second; stdout, stderr and the samples are kept. */
async function runCli(argv: string[], env: Record<string, string>, name: string, killAfterS?: number): Promise<{ code: number | null; stdout: string; stderr: string; peakMb: number }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'), ...argv], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const out = join(dir, `samples-${name}.ndjson`);
  writeFileSync(out, '');
  const t0 = performance.now();
  let peakMb = 0, lastProgress = '';
  const errChunks: string[] = [];
  const reader = (async () => { for await (const chunk of child.stderr) { const text = new TextDecoder().decode(chunk); errChunks.push(text); const lines = text.split('\n').filter(line => line.startsWith('[sources canonical]') || line.includes('conversion_progress')); if (lines.length) lastProgress = lines.at(-1)!; } })();
  const timer = setInterval(() => {
    const rss = rssOf(child.pid);
    if (rss === null) return;
    peakMb = Math.max(peakMb, rss);
    const t = Math.round((performance.now() - t0) / 100) / 10;
    appendFileSync(out, JSON.stringify({ t, rss_mb: rss, progress: lastProgress }) + '\n');
    if (killAfterS !== undefined && t >= killAfterS) child.kill('SIGTERM');
  }, 1000);
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  clearInterval(timer); await reader;
  const stderr = errChunks.join('');
  writeFileSync(join(dir, `stderr-${name}.log`), stderr);
  return { code, stdout, stderr, peakMb };
}

async function cliRun(): Promise<void> {
  const embed = args.includes('--embed'), seedEmbed = command === 'embed-seed';
  const stub = embed || seedEmbed ? await startEmbeddingStub({ latencyMs: Number(flag('latency', '300')), maxConcurrent: Number(flag('concurrency', '2')), dims: 1024 }) : null;
  const seeded = JSON.parse(await Bun.file(join(dir, 'seed.json')).text()) as { head: string };
  const target = seedEmbed ? SEED_DB : RUN_DB;
  if (!seedEmbed) {
    const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS ' + RUN_DB + ' WITH (FORCE)');
    await admin.unsafe('CREATE DATABASE ' + RUN_DB + ' TEMPLATE ' + SEED_DB);
    await admin.end();
    git('reset', '-q', '--hard', seeded.head); git('clean', '-qfd');
    // --durable: the box's shape, git durability on with a tracking remote; every Git effect commits and pushes.
    if (args.includes('--durable')) {
      const remote = join(dir, 'remote.git');
      rmSync(remote, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', remote]);
      try { git('remote', 'remove', 'origin'); } catch { /* none yet */ }
      git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'HEAD:refs/heads/main');
      git('branch', '--set-upstream-to=origin/main');
      const engine = await open(RUN_DB);
      try { console.error('durable bindings: ' + (await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' RETURNING git_durability")).length); }
      finally { await engine.disconnect(); }
    }
  }
  writeConfig(target, embed || seedEmbed);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GBRAIN_HOME: home, GBRAIN_MEMORY_TRACE: flag('trace', '10')!,
    ...(stub ? { OPENAI_API_KEY: 'bench-stub-key', OPENAI_BASE_URL: stub.url } : {}) };
  try {
    if (seedEmbed) {
      const done = await runCli(['embed', '--stale', '--yes', '--json'], env, 'embed-seed');
      console.error(`embed-seed exit ${done.code} peak ${done.peakMb} MB; stub ${JSON.stringify(stub!.stats)}\n${done.stdout.slice(-600)}`);
      return;
    }
    const argv = mode === 'sync' ? ['sync', '--source', 'default', '--no-pull', ...(args.includes('--full') ? ['--full'] : []), ...(embed ? [] : ['--no-embed']), ...(EXTRACT ? [] : ['--no-extract']), '--json']
      : null;
    let hash = '';
    if (!argv) {
      const preview = await runCli(['sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'], env, 'preview');
      const parsed = JSON.parse(preview.stdout.trim().split('\n').at(-1)!);
      hash = parsed.preview_hash;
      console.error(`preview: adopt ${parsed.adopt.count} declared ${parsed.declared.count} withhold ${parsed.withhold.count} discard ${parsed.discard.count} hash ${hash}`);
    }
    const run = await runCli(argv ?? ['sources', 'canonical', 'default', '--to', 'git', '--apply', '--expect', hash, ...(embed ? [] : ['--no-embed']), ...(EXTRACT ? [] : ['--no-extract']), '--json'],
      env, mode, flag('kill-after') ? Number(flag('kill-after')) : undefined);
    console.error(`${mode}: exit ${run.code} peak ${run.peakMb} MB${stub ? `; stub ${JSON.stringify(stub.stats)}` : ''}\nstdout tail: ${run.stdout.slice(-1500)}`);
  } finally { stub?.close(); }
}

if (!dir) throw new Error('--dir is required');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (command === 'seed') await seed();
else if (command === 'run') await run();
else if (command === 'cli' || command === 'embed-seed') await cliRun();
else throw new Error('usage: seed | run');
process.exit(0);
