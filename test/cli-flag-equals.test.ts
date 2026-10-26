/**
 * #7619: `--flag=value` on CLI_ONLY commands must mean exactly what
 * `--flag value` means or refuse. The validator accepted the `=` form of
 * every registered flag while most handlers read only the separate-token
 * form, so the value was dropped with no error (`serve --access=read-only`
 * served every write tool). cliOnlyFlagArgs is the argv every CLI_ONLY
 * handler receives; these tables run it over every registered flag of every
 * command.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { CLI_ONLY, cliOnlyFlagArgs, validateCommandFlags } from '../src/cli/main.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { END_OF_OPTIONS, EQUALS_READERS, OWN_EQUALS_PARSERS, knownSwitches } from '../src/cli/flag-equals.ts';
import { SYNC_FLAGS } from '../src/core/sync-flags.ts';
import { strictSpecFor } from '../src/cli/strict-args.ts';
import { surfaceFileSource } from './helpers/source-surface.ts';
import { loadCuratedHelp } from '../src/cli/help/render.ts';
import { parseAccessFlag, parseSurfaceFlag } from '../src/mcp/surface.ts';
import { parseMovementArgs } from '../src/commands/sources-writer-movement.ts';
import { parseAddTypeArgs } from '../src/commands/schema-add-type.ts';

const PASSTHROUGH = new Set(['call', 'retrieval-upgrade']);

async function argvFor(command: string, args: string[]): Promise<string[]> {
  const r = await cliOnlyFlagArgs(command, args);
  if ('refusal' in r) throw new Error(`refused: ${r.refusal.message}`);
  return r.args;
}

async function refusalFor(command: string, args: string[]): Promise<string | null> {
  const r = await cliOnlyFlagArgs(command, args);
  return 'refusal' in r ? r.refusal.message : null;
}

async function ownTable(command: string): Promise<Map<string, string>> {
  const types = new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type] as [string, string]));
  if (command === 'sync') for (const [flag, spec] of Object.entries(SYNC_FLAGS as Record<string, { arity: string }>)) if (!types.has(flag)) types.set(flag, spec.arity);
  return types;
}

describe('#7619 table: every registered CLI_ONLY flag', () => {
  test('the = form splits only on the command\'s own value flags and otherwise refuses', async () => {
    const switches = await knownSwitches();
    const wrong: string[] = [];
    let checked = 0;
    const outcomes = { split: 0, kept: 0, refused: 0 };
    for (const command of CLI_ONLY) {
      const legal = CLI_FLAG_REGISTRY[command];
      if (!legal || PASSTHROUGH.has(command) || OWN_EQUALS_PARSERS.has(command)) continue;
      const own = await ownTable(command);
      for (const flag of legal) {
        checked++;
        const value = 'alpha=beta,gamma';
        const r = await cliOnlyFlagArgs(command, [`${flag}=${value}`]);
        const got = 'refusal' in r ? 'refused'
          : r.args.length === 1 && r.args[0] === `${flag}=${value}` ? 'kept'
          : JSON.stringify(r.args) === JSON.stringify([flag, value]) ? 'split' : `other ${JSON.stringify(r.args)}`;
        if (got in outcomes) outcomes[got as keyof typeof outcomes]++;
        const listed = EQUALS_READERS[command]?.includes(flag);
        const isSwitch = own.has(flag) ? own.get(flag) === 'boolean' : flag.startsWith('--no-') || switches.has(flag);
        if (got === 'split' && (!own.has(flag) || own.get(flag) === 'boolean')) wrong.push(`${command} ${flag}: split without a value in the command's own table`);
        if (got === 'split' && validateCommandFlags(command, (r as { args: string[] }).args) !== null) wrong.push(`${command} ${flag}: split argv fails validation`);
        if (got === 'kept' && !listed) wrong.push(`${command} ${flag}: kept whole for a handler that may read only the separate form`);
        if (got !== 'refused' && isSwitch && !listed) wrong.push(`${command} ${flag}: a switch was not refused`);
        if (got === 'refused' && (listed || own.has(flag) && !isSwitch)) wrong.push(`${command} ${flag}: refused a form the handler reads`);
        if (got.startsWith('other')) wrong.push(`${command} ${flag}: ${got}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
    expect(outcomes.split).toBeGreaterThan(40);
    expect(outcomes.kept).toBeGreaterThan(50);
    expect(outcomes.refused).toBeGreaterThan(1000);
  });

  test('an empty or flag-like value refuses on every flag, and no refusal echoes the value', async () => {
    const wrong: string[] = [];
    for (const command of CLI_ONLY) {
      const legal = CLI_FLAG_REGISTRY[command];
      if (!legal || PASSTHROUGH.has(command) || OWN_EQUALS_PARSERS.has(command)) continue;
      for (const flag of legal) {
        if (EQUALS_READERS[command]?.includes(flag)) continue;
        for (const value of ['', '--x', '-y', '-h']) {
          if (await refusalFor(command, [`${flag}=${value}`]) === null) wrong.push(`${command} ${flag}=${value} accepted`);
        }
        const message = await refusalFor(command, [`${flag}=-SecretValue-alpha`]);
        if (message?.includes('SecretValue')) wrong.push(`${command} ${flag}: refusal echoes the value`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('#7619 split rules', () => {
  test('a value containing = splits at the first =', async () => {
    expect(await argvFor('serve', ['--public-url=https://brain.example.com/?a=b'])).toEqual(['--public-url', 'https://brain.example.com/?a=b']);
  });

  test('a bare -- ends the scan only where the handler honors it', async () => {
    expect(await argvFor('serve', ['--', '--access=read-only'])).toEqual(['--', '--access', 'read-only']);
    expect(await refusalFor('auth', ['create', '--', 'bot-example', '--scopes=read'])).toContain('--scopes=…');
    expect(await refusalFor('serve', ['--', '--source-guard=true'])).toContain('--source-guard is a switch');
    expect(await argvFor('agent', ['run', '--', 'tool', '--access=read-only', '-y=n'])).toEqual(['run', '--', 'tool', '--access=read-only', '-y=n']);
    expect(await argvFor('frontmatter', ['validate', '--', '--path=x.md'])).toEqual(['validate', '--', '--path=x.md']);
    expect([...END_OF_OPTIONS].sort()).toEqual(['agent run', 'frontmatter validate']);
    for (const [command, args, flag] of [
      ['frontmatter', ['generate', 'notes/', '--fix', '--', '--dry-run=true'], '--dry-run'],
      ['questions', ['pin', '--', 'what is x', '--source=source-a'], '--source'],
      ['questions', ['list', '--', '--source=source-a'], '--source'],
      ['agent', ['logs', '1', '--', '--since=1h'], '--since'],
    ] as const) {
      expect(await refusalFor(command, [...args])).toContain(`${flag}=…`);
    }
  });

  test('after a bare -- the handler reads past, an unregistered or misspelled = token refuses', async () => {
    expect(await refusalFor('auth', ['create', 'agent-a', '--', '--Scopes=read'])).toContain('not a flag of this command');
    expect(await refusalFor('serve', ['--', '--Access=read-only'])).toContain('not a flag of this command');
    expect(await refusalFor('serve', ['--', '--definitely-not-a-flag=x'])).toContain('--definitely-not-a-flag=…');
    expect(await argvFor('frontmatter', ['validate', '--', '--Path=x.md'])).toEqual(['validate', '--', '--Path=x.md']);
  });

  test('a true/false word on a switch with no table entry never suggests the value form', async () => {
    for (const [command, args] of [['transcripts', ['recover', 'codex', '--apply=false']], ['trust', ['claim-sources', '--accept-all=no']], ['dream', ['--unsafe-bypass-dream-guard=off']]] as const) {
      const message = await refusalFor(command, [...args]);
      expect(message).toContain('takes no true/false value');
      expect(message).not.toContain('<value>');
    }
  });

  test('sources pull --path= refuses instead of falling through to the engine route', async () => {
    expect(await refusalFor('sources', ['pull', '--path=/repo-example'])).toContain('takes --path <value> as two arguments');
  });

  test('the = gate list matches the hand-dispatched search dashboard subcommands', () => {
    const src = surfaceFileSource('cli', 'src/cli/main.ts');
    const dispatch = /command === 'search' && (\[[^\]]+\])\.includes\(subArgs\[0\] \?\? ''\)/.exec(src)?.[1];
    const gate = /const SEARCH_DASHBOARD_SUBCOMMANDS = (\[[^\]]+\]);/.exec(src)?.[1];
    expect(dispatch).toBeDefined();
    expect(gate).toBe(dispatch);
  });

  test('an unknown flag keeps its token so the validator names it', async () => {
    expect(await argvFor('serve', ['--definitely-not-a-flag=x'])).toEqual(['--definitely-not-a-flag=x']);
    expect(validateCommandFlags('serve', ['--definitely-not-a-flag=x'])).toBe('--definitely-not-a-flag');
  });

  test('a curated number or enum flag splits any value, switch-like ones included', async () => {
    expect(await argvFor('serve', ['--stdio-idle-timeout=0'])).toEqual(['--stdio-idle-timeout', '0']);
    expect(await argvFor('serve', ['--token-ttl=60'])).toEqual(['--token-ttl', '60']);
  });

  test('the sync flag table splits sync values', async () => {
    expect(await argvFor('sync', ['--source=source-a', '--interval=60'])).toEqual(['--source', 'source-a', '--interval', '60']);
  });

  test('a curated switch refuses the = form with the bare spelling', async () => {
    for (const token of ['--source-guard=true', '--source-guard=false', '--http=1']) {
      const message = await refusalFor('serve', [token]);
      expect(message).toContain(`${token.split('=')[0]}=…`);
      expect(message).toContain('is a switch and takes no value');
    }
  });

  test('a negation refuses the = form', async () => {
    expect(await refusalFor('sync', ['--no-pull=true'])).toContain('--no-pull is a switch');
    expect(CLI_FLAG_REGISTRY.forget).not.toContain('--no-purge');
    expect(await refusalFor('forget', ['--no-purge=1'])).toContain('--no-purge is a switch');
  });

  test('commands that read the = form themselves keep their argv', async () => {
    expect(await argvFor('config', ['set', 'k', '--x=true'])).toEqual(['set', 'k', '--x=true']);
    expect(await argvFor('pages', ['purge-deleted', '--older-than=72'])).toEqual(['purge-deleted', '--older-than=72']);
    expect(await argvFor('embed', ['--pace=gentle'])).toEqual(['--pace=gentle']);
    expect(await argvFor('doctor', ['--scope=brain'])).toEqual(['--scope=brain']);
    expect(await argvFor('search', ['--limit=5'])).toEqual(['--limit=5']);
    expect(await argvFor('retrieval-upgrade', ['--yes=true'])).toEqual(['--yes=true']);
    expect(await argvFor('migrate', ['embeddings', '--to=x'])).toEqual(['embeddings', '--to=x']);
    expect(await argvFor('eval', ['brainbench', '--x=1'])).toEqual(['brainbench', '--x=1']);
    expect(await argvFor('call', ['x', '--y=true'])).toEqual(['x', '--y=true']);
    expect(await argvFor('edge-proposals', ['list', '--status=all', '--limit=5'])).toEqual(['list', '--status=all', '--limit=5']);
    expect(await argvFor('recall', ['--source-id=peer', '--json'])).toEqual(['--source-id=peer', '--json']);
    expect(await argvFor('export', ['--source=default', '--dir=out-example'])).toEqual(['--source=default', '--dir=out-example']);
    expect(await argvFor('skillpack', ['reference', '--harness=claude-code'])).toEqual(['reference', '--harness=claude-code']);
    expect(await argvFor('sources', ['status', '--limit=5'])).toEqual(['status', '--limit=5']);
  });

  test('every subcommand reader key keeps exactly its flags on its own path', async () => {
    const wrong: string[] = [];
    for (const [key, flags] of Object.entries(EQUALS_READERS)) {
      const [command, sub] = key.split(' ') as [string, string | undefined];
      if (!sub || OWN_EQUALS_PARSERS.has(command)) continue;
      for (const flag of CLI_FLAG_REGISTRY[command] ?? []) {
        if (strictSpecFor(command, [sub, `${flag}=v`])) continue;
        const r = await cliOnlyFlagArgs(command, [sub, `${flag}=v`]);
        const kept = 'args' in r && r.args.length === 2 && r.args[1] === `${flag}=v`;
        const listed = flags.includes(flag) || (EQUALS_READERS[command]?.includes(flag) ?? false);
        if (kept !== listed) wrong.push(`${key} ${flag}: ${kept ? 'kept but not listed' : 'listed but not kept'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('a reader key covers only its own subcommand', async () => {
    expect(await refusalFor('edge-proposals', ['accept', '--limit=5', '7'])).toContain('--limit=…');
    expect(await refusalFor('jobs', ['list', '--refresh-ms=500'])).toContain('--refresh-ms=…');
    expect(await refusalFor('pages', ['purges', '--limit=5'])).toContain('--limit=…');
    expect(await argvFor('pages', ['unsearchable', '--limit=5'])).toEqual(['unsearchable', '--limit=5']);
  });

  test('a strict spec whose when is false falls through to the entry rule', async () => {
    expect(await refusalFor('skillpack', ['reference', '--harness', 'claude-code', '--from=x'])).toContain('takes --from <value> as two arguments');
    expect(await refusalFor('skillpack', ['reference', '--harness', 'claude-code', '--dry-run=true'])).toContain('--dry-run=…');
  });

  // Every module that reads a --flag=value token is classified: an EQUALS_READERS key it serves, or why no key is needed.
  test('EQUALS_READERS keys and the = readers in src match in both directions', () => {
    const MODULE_OWNERS: Record<string, readonly string[] | string> = {
      // owners
      'src/cli/commands/doctor.ts': ['doctor'],
      'src/commands/beliefs-replay-purges.ts': ['beliefs replay-purges'],
      'src/commands/beliefs.ts': ['beliefs', 'beliefs changes'],
      'src/commands/capture.ts': ['capture'],
      'src/commands/check-resolvable.ts': ['check-resolvable', 'doctor'],
      'src/commands/code-scope.ts': ['code-callees', 'code-callers', 'code-def', 'code-refs'],
      'src/commands/compile-context.ts': ['compile-context'], // *
      'src/commands/doctor.ts': ['doctor'],
      'src/commands/doctor/budget.ts': ['doctor'],
      'src/commands/doctor/registry.ts': ['doctor'],
      'src/commands/edge-proposals.ts': ['edge-proposals list'],
      'src/commands/embed.ts': ['embed'],
      'src/commands/eval-conversation-parser.ts': ['eval conversation-parser'],
      'src/commands/eval-takes-quality.ts': ['eval takes-quality'],
      'src/commands/export.ts': ['export'],
      'src/commands/forget-purge.ts': ['forget'],
      'src/commands/frontmatter-install-hook.ts': ['frontmatter install-hook'],
      'src/commands/frontmatter.ts': ['frontmatter validate', 'frontmatter audit'],
      'src/commands/graph-query.ts': ['graph-query'],
      'src/commands/import.ts': ['import'],
      'src/commands/integrity.ts': ['integrity check'],
      'src/commands/jobs/shared.ts': ['jobs supervisor'],
      'src/commands/jobs/watch.ts': ['jobs watch'],
      'src/commands/lint.ts': ['lint'],
      'src/commands/migrate-graduation.ts': ['migrate'],
      'src/commands/models.ts': ['models doctor'],
      'src/commands/pages.ts': 'pages purge-deleted strict parser (STRICT_SUBCOMMANDS)',
      'src/commands/pages-ghosts.ts': ['pages ghosts'],
      'src/commands/pages-purges.ts': ['pages purges', 'pages unpurge'],
      'src/commands/pages-status.ts': ['pages status'],
      'src/commands/pages-unsearchable.ts': ['pages unsearchable'],
      'src/commands/recall.ts': ['recall', 'forget'],
      'src/commands/reindex.ts': ['reindex'],
      'src/commands/resolvers.ts': ['resolvers list'],
      'src/commands/routing-eval.ts': ['routing-eval'],
      'src/commands/schema.ts': ['schema active', 'schema detect', 'schema suggest', 'schema review-candidates', 'schema review-orphans', 'schema stats', 'schema cardinality-preview', 'schema sync', 'schema lint', 'schema reload', 'schema update-type', 'schema add-alias', 'schema add-prefix', 'schema add-link-type', 'schema set-extractable', 'schema set-expert-routing', 'schema scaffold-extractable'],
      'src/commands/skillify.ts': ['skillify scaffold'],
      'src/commands/skillpack.ts': ['skillpack status', 'skillpack sync', 'skillpack migrate-fence', 'skillpack scrub-legacy-fence-rows', 'skillpack harvest', 'skillpack diff'],
      'src/commands/skillpack/harness.ts': ['skillpack scaffold', 'skillpack reference'], // also the OWN parser of skillpack remove
      'src/commands/skillpack/reference.ts': ['skillpack reference'],
      'src/commands/skillpack/scaffold.ts': ['skillpack scaffold'],
      'src/commands/sources-harden.ts': ['sources harden', 'sources pull'], // *
      'src/commands/sources.ts': ['sources status'], // * (paged regex :1214)
      'src/commands/status.ts': ['status'],
      'src/commands/sync/operator.ts': ['sync status'],
      'src/commands/trust-claim.ts': ['trust claim-sources'],
      'src/core/bounded-listing-cli.ts': ['orphans', 'sources status', 'sync status'],
      'src/core/consent.ts': ['decide enable', 'doctor', 'embed', 'features', 'migrate', 'reindex', 'reindex-code'],
      'src/core/stable-channel.ts': ['upgrade'],
      'src/eval/decide-eval-flags.ts': ['eval retrieval-quality'], // also eval brainbench (exempt) and eval longmemeval (own)

      // own parsers (OWN_EQUALS_PARSERS)
      'src/cli/commands/append.ts': 'own parser: append (and the put op, not CLI_ONLY)',
      'src/commands/company-brain-connect.ts': 'own parser: sources connect',
      'src/commands/company-brain-inspect.ts': 'own parser: sources inspect',
      'src/commands/eval-longmemeval.ts': 'own parser: eval longmemeval',
      'src/eval/longmemeval/call-plan.ts': 'own parser: eval longmemeval (argv rebuild skips --call-plan=)',
      'src/commands/git.ts': 'own parser: git',
      'src/commands/persistence-admin.ts': 'own parser: auth local-writer, sources writer',
      'src/commands/repair.ts': 'own parser: repair',
      'src/commands/schema-add-type.ts': 'own parser: schema add-type (schemaPositionals/withoutFlag are positional helpers)',
      'src/commands/source-reconcile.ts': 'own parser: sources reconcile',
      'src/commands/sources-lifecycle-args.ts': 'managed/delegated sources add|remove|archive|restore|purge|set-path|reclone parser; legacy fallback reads exact tokens only (see below)',
      'src/commands/sources-reset-upstream.ts': 'own parser: sources reset-upstream (:90,:135 are git args)',
      'src/commands/sources-writer-movement.ts': 'own parser: sources writer',
      'src/commands/takes-mutation.ts': 'own parser: takes add|update|supersede|resolve|remove (:116 filters a fix argv); takes rebuild reads --source-id exact (:172)',
      'src/core/embedding-migration-cli.ts': 'own parser: migrate embeddings, retrieval-upgrade',

      // reads both forms but not a handler decision, or not CLI_ONLY argv
      'src/cli/command-table.ts': 'sourceArg (:126) labels the sync status heartbeat only',
      'src/cli/slow-read.ts': 'flagValue for heartbeat labels only',
      'src/cli/fix-routing-provider.ts': 'reads the raw pre-split argv (installCliRoutingFor, main.ts:317) to pin fix routing',
      'src/core/fix-routing.ts': 'hasFlag over generated fix argv',
      'src/cli/help/validate.ts': 'curatedFlagError: typed-value validation of curated flags, both forms',
      'src/cli/main.ts': 'parseOpArgs (op commands, not CLI_ONLY); extract attendance route (:337) runs before cliOnlyFlagArgs on raw argv; eval brainbench --decide= (exempt)',
      'src/cli/op-param-values.ts': 'op param k=v pairs, not CLI_ONLY flags',
      'src/core/op-flag-tokens.ts': 'op commands, not CLI_ONLY',
      'src/cli/flag-equals.ts': 'the gate itself',
      'src/cli/strict-args.ts': 'strict subcommand parser (passed through by cliOnlyFlagArgs)',
      'src/core/cli-options.ts': 'global options, stripped by parseGlobalFlags before dispatch',
      'src/commands/call.ts': 'call is flagValidationExempt',
      'src/commands/doctor/default-budget.ts': 'presence check (EXPLICIT_MODE_FLAGS) only; values read by doctor/budget.ts',
      'src/commands/doctor/remediate-consent.ts': 'argv rebuild strips --expect=/--brain=; value read by core/consent.ts',
      'src/core/reindex-consent.ts': 'argv rebuild strips --max-usd=/--max-cost=; value read by core/consent.ts',
      'src/core/embed-cost-cap.ts': 'argv rebuild strips --max-usd=/--max-cost=', // *
      'src/core/minions/spend-authorization.ts': 'resume argv rebuild strips --max-*=', // *
      'src/commands/connect.ts': 'consent argv strips --token= so a token is never echoed; parser reads exact tokens',
      'src/commands/dream.ts': 'message text only; collectFlagValues reads exact tokens',
      'src/commands/extract-stale-options.ts': 'validation only; the extract --stale run reads --source-id exact (extract.ts:969), so keeping --source-id= would sweep every source',
      'src/commands/extract-stale-delegate.ts': 'literal --source=db mode token; refuses other = forms',
      'src/commands/thin-client-routing.ts': 'thin-client beliefs changes refuses --source and --source= alike; flagValue reads exact tokens',
      'src/core/persistence/soak-counters.ts': 'telemetry presence check of sync flags',
      'src/core/cli-force-exit.ts': '--json=true (splitFlagEquals rewrites it to --json)',
      'src/core/interop-notices.ts': '--json=true (splitFlagEquals rewrites it to --json)',
      'src/core/trust/confirm.ts': 'guard on generated fix argv (--yes=)',
      'src/core/upgrade-restart.ts': 'parses a running supervisor\'s ps argv, not CLI input',
      'src/commands/upgrade-restart.ts': 'parses process env vars (NAME=value), not CLI input',
      'src/core/company-brain/revision.ts': 'builds a fix argv (--exclude=)',
      'src/core/behavior-change-notice.ts': 'notice text',
      'src/core/pace-mode.ts': 'comment only',
      'src/commands/doctor/context.ts': 'comment only',
      'src/commands/doctor/last-known.ts': 'internal buildChecks call passes --scope=brain',
      'src/commands/maintain.ts': 'internal buildChecks call passes --scope=brain',
      'src/core/persistence/engine-graduation.ts': 'internal buildChecks / doctor child pass --scope=brain',
      'src/commands/doctor/checks/harness-wiring.ts': 'parses a config line (key=value)',
      'src/core/persistence/index-lock-reclaim.ts': 'parses a lock entry (key=value)',
      'src/core/minions/legacy-selection.ts': '--select value grammar (status=a|b), not a flag',
      'src/core/bootstrap/hooks.ts': 'shell words of hook commands',
      'src/core/cli-preflight.ts': 'Bun runtime execArgv (--preload=...), not gbrain argv',

      // child-process argv builders (git/tar/tailscale flags)
      'src/commands/doctor/checks/git-convergence.ts': 'git child argv',
      'src/commands/doctor/checks/git-writer.ts': 'git child argv',
      'src/commands/sync/rename-reconcile.ts': 'git child argv',
      'src/core/facts/fence-write.ts': 'git child argv',
      'src/core/facts/purge-verify.ts': 'git child argv',
      'src/core/fence-repair/uncommitted.ts': 'git child argv',
      'src/core/git-first-commit.ts': 'git child argv',
      'src/core/git-head.ts': 'git child argv',
      'src/core/git-remote.ts': 'git child argv',
      'src/core/git/commit-push.ts': 'git child argv',
      'src/core/persistence/checkout-state.ts': 'git child argv',
      'src/core/persistence/effect-git.ts': 'git child argv',
      'src/core/persistence/git-door.ts': 'git child argv',
      'src/core/persistence/hosted-repo.ts': 'git child argv',
      'src/core/persistence/sync-freshness.ts': 'git child argv',
      'src/core/persistence/sync-origin-evidence.ts': 'git child argv',
      'src/core/persistence/topology-filesystem.ts': 'git child argv',
      'src/core/persistence/worktree-refresh.ts': 'git child argv',
      'src/core/skillpack/bundle.ts': 'git child argv',
      'src/core/skillpack/tarball.ts': 'tar child argv',
      'src/core/source-health.ts': 'git child argv',
      'src/core/sync-reconcile.ts': 'git child argv',
      'src/core/sync-upstream.ts': 'git child argv',
      'src/core/tailscale.ts': 'tailscale child argv',
      'src/core/workspace-push.ts': 'git child argv',
      'src/eval/longmemeval/via-operation.ts': 'git child argv',
    };
    const READER = [/['"`]--[a-z0-9-]+=/, /(?:startsWith|indexOf|===)\(?\s*`\$\{\w+\}=`/, /startsWith\(\w+ \+ '='\)/];
    const found = [...new Glob('src/**/*.ts').scanSync('.')].filter(p => !p.endsWith('.generated.ts') && READER.some(r => r.test(readFileSync(p, 'utf8'))));
    expect(found.filter(p => !(p in MODULE_OWNERS))).toEqual([]);
    for (const p of Object.keys(MODULE_OWNERS)) expect(readFileSync(p, 'utf8').length).toBeGreaterThan(0);
    const owned = new Set(Object.values(MODULE_OWNERS).filter(v => Array.isArray(v)).flat());
    expect([...owned].sort()).toEqual(Object.keys(EQUALS_READERS).sort());
    for (const [key, flags] of Object.entries(EQUALS_READERS)) for (const flag of flags) expect(CLI_FLAG_REGISTRY[key.split(' ')[0]!]).toContain(flag);
  });
});

describe('#7619 refusals that keep consent, scope and targets right', () => {
  test('a switch never splits into the switch plus a stray positional', async () => {
    for (const [command, args] of [
      ['reinit-pglite', ['--yes=n']], ['reinit-pglite', ['--yes=nope']], ['reinit-pglite', ['--yes=disabled']],
      ['forget', ['--purge=n']], ['embed', ['--stale=alice-example']], ['embed', ['--all=alice-example']], ['sync', ['--dry-run=alice-example']],
      ['forget', ['--purge', '--continue=12', '--yes', '--request-id', 'r1']],
      ['frontmatter', ['validate', 'x.md', '--fix', '--include-ambiguous=n']],
      ['init', ['--non-interactive=n']], ['init', ['--rebuild=n']], ['init', ['--supabase=on']], ['init', ['--pglite=1']],
      ['dream', ['--unsafe-bypass-dream-guard=never']], ['dream', ['--unsafe-bypass-dream-guard=1']],
      ['auth', ['--enable-dcr-insecure=disabled']], ['sync', ['--status=true']], ['forget', ['--status=yes']],
      ['setup', ['--remove=yes']], ['bootstrap', ['--remove=yes']], ['mcp', ['expose', '--remove=yes']], ['quarantine', ['--yes=n']],
      ['skillpack', ['scaffold', '--harness', 'claude-code', '--dry-run=true']],
    ] as const) {
      const token = args.find(a => a.includes('='))!;
      expect(CLI_FLAG_REGISTRY[command]).toContain(token.split('=')[0]!);
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    }
  });

  test('a value flag the handler reads only as a separate argument refuses with that spelling instead of being dropped', async () => {
    for (const [command, args, flag] of [
      ['auth', ['create', 'bot-example', '--scopes=read'], '--scopes'], ['auth', ['create', 'bot-example', '--takes-holders=world'], '--takes-holders'],
      ['connect', ['https://a.example', '--scopes=read'], '--scopes'], ['takes', ['propose', '--accept=12'], '--accept'],
      ['reinit-pglite', ['--path=/tmp/brain-example'], '--path'], ['bootstrap', ['interview', '--confirm=abc123'], '--confirm'],
      ['extract', ['links', '--source', 'db', '--source-id=source-a'], '--source-id'], ['extract', ['--stale', '--source-id=source-a'], '--source-id'],
      ['trust', ['explain', 'ref-example', '--source=source-a'], '--source'], ['jobs', ['work', '--concurrency=4'], '--concurrency'],
      ['forget', ['34', '--reason=stale-example'], '--reason'], ['migrate', ['--to=pglite'], '--to'],
      ['jobs', ['submit', 'shell', '--params={"a":1}'], '--params'], ['jobs', ['submit', 'sync', '--max-usd=5'], '--max-usd'],
      ['search', ['diagnose', 'q', '--target', 'x', '--source=source-a'], '--source'],
    ] as const) {
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.message).toContain(`takes ${flag} <value> as two arguments`);
      expect('refusal' in r && r.refusal.suggestion).toContain(`${flag} <value>`);
    }
  });

  // Value: protects=a split value never becomes the first numeric/slug target (forget --purge --reason=3 34 must not hit fact 3); fails_when=a refusal turns into a split or keep; why_new=rows only asserted not-null; seam=none; no_claim=handler behavior after a split (argv-level only)
  test('a flag value never becomes the numeric or slug target of a mutating subcommand', async () => {
    for (const [command, args] of [
      ['forget', ['--purge', '--reason=3', '34', '--dry-run']],
      ['edge-proposals', ['accept', '--limit=3', '7']], ['edge-proposals', ['accept', '--row=3', '7']],
      ['decide', ['proposals', 'accept', '--limit=3', '7']],
      ['loops', ['drop', '--note=7', '12']], ['pages', ['unpurge', '--source-id=people/alice-example', 'people/bob-example']],
      ['takes', ['propose', '--accept', '7', '--weight=3']],
    ] as const) {
      const token = args.find(a => a.includes('='))!;
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.code).toBe('invalid_params');
      expect('refusal' in r && r.refusal.message).toContain(`${token.split('=')[0]}=…`);
      expect('refusal' in r && r.refusal.message).not.toContain(token);
    }
  });

  test('a short flag with = refuses instead of being ignored or taken as consent', async () => {
    for (const [command, args] of [
      ['reinit-pglite', ['-y=n']], ['reinit-pglite', ['-y=yes']], ['reindex-code', ['-y=1']], ['serve', ['-h=1']],
    ] as const) {
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.code).toBe('invalid_params');
      expect('refusal' in r && r.refusal.message).toContain(`${args[0]!.slice(0, 2)}=…`);
      expect('refusal' in r && r.refusal.message).toContain('a short flag takes no =');
    }
  });

  test('validation-exempt paths that read exact tokens refuse the = form', async () => {
    for (const [command, args, flag] of [
      ['jobs', ['submit', 'sync', '--dry-run=true', '--queue-only'], '--dry-run'], ['jobs', ['submit', 'shell', '--follow=1'], '--follow'],
      ['config', ['unset', 'chat_model', '--file=true'], '--file'], ['config', ['get', 'chat_model', '--json=false'], '--json'],
      ['sources', ['remove', 'source-a', '--yes', '--dry-run=true'], '--dry-run'], ['sources', ['archive', 'source-a', '--dry-run=1'], '--dry-run'],
      ['sources', ['add', 'source-a', '--path=/tmp/repo-example'], '--path'], ['search', ['modes', '--mode=balanced'], '--mode'],
    ] as const) {
      const r = await cliOnlyFlagArgs(command, [...args]);
      expect('refusal' in r && r.refusal.message).toContain(`${flag}=…`);
    }
    expect(await argvFor('config', ['set', 'k', '--x=true'])).toEqual(['set', 'k', '--x=true']);
  });

  test('settle paths receive their value flags in the form their handlers read', async () => {
    expect(await argvFor('sync', ['unblock', '--source=source-b', '--apply'])).toEqual(['unblock', '--source', 'source-b', '--apply']);
    const doctor = await argvFor('doctor', ['--remediate', '--yes', '--max-usd=0.01', '--expect=abc123']);
    expect(doctor).toEqual(['--remediate', '--yes', '--max-usd', '0.01', '--expect=abc123']);
  });

  test('subcommands with their own = parser get their argv unchanged', async () => {
    for (const [command, args] of [
      ['takes', ['resolve', 'people/alice-example', '--row=1', '--by=alice-example']],
      ['takes', ['add', 'people/alice-example', '--claim=x', '--by=1']],
      ['sources', ['reconcile', 'notes', '--apply=plan-example.json', '--remove-backup=id-example']],
      ['auth', ['local-writer', 'register', '--expected-epoch=1', '--scopes=read,write']],
      ['repair', ['file-drift', '--generation=1', '--keep=database']],
      ['eval', ['longmemeval', 'data.jsonl', '--top-k=1', '--autocut=on']],
      ['skillpack', ['remove', '--harness=claude-code', '--persona=alice-example']],
      ['schema', ['add-type', 'note', '--alias=n', '--primitive=entity']],
      ['git', ['commit-push', '--message=alpha', '--resolve=a.md=ours']],
    ] as const) expect(await argvFor(command, [...args])).toEqual([...args]);
  });

  test('own = parsers refuse a value on their own switches', () => {
    expect(() => parseMovementArgs(['source-a', '--warn-only=false'])).toThrow('--warn-only is a switch');
    expect(() => parseMovementArgs(['source-a', '--json=false'])).toThrow('--json is a switch');
    expect(parseMovementArgs(['source-a', '--warn-only', '--json'])).toMatchObject({ warnOnly: true, json: true });
    expect(() => parseAddTypeArgs(['note', '--primitive=entity', '--no-prefix=false'])).toThrow('--no-prefix is a switch');
    expect(() => parseAddTypeArgs(['note', '--primitive=entity', '--prefix=notes/', '--extractable=false'])).toThrow('--extractable is a switch');
    expect(parseAddTypeArgs(['note', '--primitive=entity', '--no-prefix'])).toMatchObject({ noPrefix: true });
  });

  test('OWN_EQUALS_PARSERS and the = option parsers match in both directions', () => {
    const OWNERS: Record<string, string | null> = {
      'src/commands/company-brain-connect.ts': 'sources connect', 'src/commands/company-brain-inspect.ts': 'sources inspect',
      'src/commands/eval-longmemeval.ts': 'eval longmemeval', 'src/commands/git.ts': 'git', 'src/commands/persistence-admin.ts': 'auth local-writer',
      'src/commands/repair.ts': 'repair', 'src/commands/schema-add-type.ts': 'schema add-type', 'src/commands/skillpack/harness.ts': 'skillpack remove',
      'src/commands/source-reconcile.ts': 'sources reconcile', 'src/commands/sources-reset-upstream.ts': 'sources reset-upstream',
      'src/commands/sources-writer-movement.ts': 'sources writer', 'src/commands/takes-mutation.ts': 'takes add',
      // normalizeReindexArgs splits its own value flags; the entry refuses other = forms before it runs.
      'src/commands/reindex.ts': null,
      // Governs managed brains only: an unmanaged brain falls back to runSources, which reads exact tokens, so the entry rule applies.
      'src/commands/sources-lifecycle-args.ts': null,
    };
    const PARSER_OF: Record<string, string> = {
      append: 'src/cli/commands/append.ts', 'auth local-writer': 'src/commands/persistence-admin.ts', 'eval longmemeval': 'src/commands/eval-longmemeval.ts',
      git: 'src/commands/git.ts', 'migrate embeddings': 'src/core/embedding-migration-cli.ts', 'retrieval-upgrade': 'src/core/embedding-migration-cli.ts',
      repair: 'src/commands/repair.ts', 'schema add-type': 'src/commands/schema-add-type.ts', 'skillpack remove': 'src/commands/skillpack/harness.ts',
      'sources connect': 'src/commands/company-brain-connect.ts', 'sources inspect': 'src/commands/company-brain-inspect.ts',
      'sources reconcile': 'src/commands/source-reconcile.ts', 'sources reset-upstream': 'src/commands/sources-reset-upstream.ts',
      'sources writer': 'src/commands/sources-writer-movement.ts', 'takes add': 'src/commands/takes-mutation.ts', 'takes remove': 'src/commands/takes-mutation.ts',
      'takes resolve': 'src/commands/takes-mutation.ts', 'takes supersede': 'src/commands/takes-mutation.ts', 'takes update': 'src/commands/takes-mutation.ts',
    };
    const found = [...new Glob('src/commands/**/*.ts').scanSync('.')].filter(p => /\b(?:eq|equal|equals) = \w+\.indexOf\('='\)/.test(readFileSync(p, 'utf8'))).sort();
    expect(found).toEqual(Object.keys(OWNERS).sort());
    for (const owner of Object.values(OWNERS)) if (owner) expect(OWN_EQUALS_PARSERS.has(owner)).toBe(true);
    expect([...OWN_EQUALS_PARSERS].sort()).toEqual(Object.keys(PARSER_OF).sort());
    for (const path of Object.values(PARSER_OF)) expect(readFileSync(path, 'utf8')).toMatch(/indexOf\('='\)|\(\?:=\(\.\*\)\)/);
  });

  test("a command's own switch wins over a value of the same name elsewhere", async () => {
    expect(await refusalFor('sync', ['status', '--detail=high'])).toContain('--detail is a switch');
    expect(await refusalFor('schema', ['detect', '--fields=x'])).toContain('--fields is a switch');
  });

  test('--json=true is the JSON switch; other values refuse', async () => {
    expect(await argvFor('doctor', ['--json=true'])).toEqual(['--json']);
    expect(await argvFor('sync', ['--json=true'])).toEqual(['--json']);
    expect(await refusalFor('sync', ['--json=false'])).toContain('--json is a switch');
  });

  test('a refused credential value is never echoed', async () => {
    const r = await cliOnlyFlagArgs('auth', ['--token=-AbcSecretValue123']);
    expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    expect(JSON.stringify(r)).not.toContain('AbcSecretValue123');
    const plain = await cliOnlyFlagArgs('auth', ['create', 'bot-example', '--scopes=AbcSecretValue123']);
    expect(JSON.stringify(plain)).not.toContain('AbcSecretValue123');
  });

  test('a curated value flag refuses an empty or flag-like value', async () => {
    for (const token of ['--access=', '--surface=--x', '--public-url=', '--token-ttl=', '--access=-y']) {
      const r = await cliOnlyFlagArgs('serve', [token]);
      expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    }
  });
});

describe('#7619 serve: the dropped safety flags reach the handler', () => {
  test('--access=read-only and --surface=verbs parse as their bare forms', async () => {
    const argv = await argvFor('serve', ['--access=read-only', '--surface=verbs']);
    expect(argv).toEqual(['--access', 'read-only', '--surface', 'verbs']);
    expect(parseAccessFlag(argv)).toBe('read-only');
    expect(parseSurfaceFlag(argv)).toBe('verbs');
    expect(parseAccessFlag(await argvFor('serve', ['--access', 'read-only']))).toBe('read-only');
    expect(parseSurfaceFlag(await argvFor('serve', ['--surface', 'starter']))).toBe('starter');
  });

  test('--token-ttl=60 reaches the --token-ttl reader', async () => {
    const argv = await argvFor('serve', ['--http', '--token-ttl=60']);
    expect(argv[argv.indexOf('--token-ttl') + 1]).toBe('60');
  });

  test('--source-guard=true refuses instead of leaving the guard off', async () => {
    const r = await cliOnlyFlagArgs('serve', ['--source-guard=true']);
    expect('refusal' in r && r.refusal.code).toBe('invalid_params');
    expect('refusal' in r && r.refusal.suggestion).toBe('Write --source-guard on its own, or leave it out.');
  });
});
