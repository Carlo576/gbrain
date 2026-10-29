/**
 * #7885: `sources canonical --to git` on a managed source whose root is not a Git checkout (a repo-less source, or a
 * fresh `git init` with no commit yet) refuses with a typed host refusal before anything is read, instead of
 * `internal_error` from a raw `git rev-parse`. The source stays usable as it is: its pages still write.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';
import { planGitConversion } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const note = (body: string) => `---\ntype: concept\ntitle: note\n---\n\n${body}\n`;
const plain = ({ root }: { root: string }) => { mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/a.md'), note('A plain file.')); };
const unborn = ({ root }: { root: string }) => { plain({ root }); execFileSync('git', ['-C', root, 'init', '-q']); };

async function cli(engine: Parameters<typeof runSourcesCanonical>[0], args: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  const log = console.log, write = process.stderr.write, priorExitCode = process.exitCode;
  console.log = (line: unknown) => { out.push(String(line)); };
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { await runSourcesCanonical(engine, args); }
  finally { console.log = log; process.stderr.write = write; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  return JSON.parse(out.at(-1)!);
}

for (const backend of testBackends()) describe(`[${backend}] #7885: --to git on a managed source without a Git checkout`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const [name, setup, code] of [['a plain directory', plain, 'git_checkout_required'], ['a git init with no commit', unborn, 'git_branch_unborn']] as const) {
    test(`${name}: preview and apply refuse ${code} with a fix, read nothing and write nothing; pages still write`, () => managedBrain(async ({ engine, ctx }) => {
      await expect(planGitConversion(engine, 'default')).rejects.toMatchObject({ code });
      for (const args of [['--dry-run', '--json'], ['--apply', '--expect', 'a'.repeat(64), '--json']]) {
        const refused = await cli(engine, ['default', '--to', 'git', ...args]);
        expect(refused).toMatchObject({ status: 'refused', code, fix: { argv: ['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--dry-run', '--json'], actor: 'user' } });
        expect(String(refused.message)).toContain('stays usable as it is');
      }
      expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config->>'canonical'='git'")).toHaveLength(0);
      const written = await operationsByName.put_page.handler(ctx, { slug: 'notes/after', content: note('Written after the refusal.') }) as { status: string };
      expect(written.status).toBe('created_or_updated');
    }, { databaseUrl, setup }), 120_000);
  }
});
