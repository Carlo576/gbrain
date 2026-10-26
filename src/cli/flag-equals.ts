/**
 * #7619: `--flag=value` on CLI_ONLY commands. The unknown-flag validator
 * accepts the `=` form of every registered flag, but most handlers read only
 * `--flag value` (`args.includes`, `args[args.indexOf(flag) + 1]`), so the
 * value was dropped with no error: `serve --access=read-only` served every
 * write tool, `auth create --scopes=read` minted a full-access token. The
 * CLI entry never lets an `=` token reach a handler that would drop it:
 *  - refuse (invalid_params, exit 2) a switch: a boolean in the command's own
 *    table (curated help, the sync flag table), a `--no-` negation, the
 *    command's COMMAND_SWITCHES, or a name whose shared-op parameter or
 *    curated flag is boolean. Splitting turns the switch on and keeping drops
 *    the value (`--dry-run=true` would write). Without the command's own
 *    table, that cross-command evidence picks the bare-switch message, so
 *    `--yes=n` is never answered with `--yes <value>`;
 *  - refuse a true/false word (`--apply=false`) with the bare-switch fix
 *    even without the command's own table, so it never suggests
 *    `--apply false`, which turns the switch on;
 *  - after a bare `--` the handler reads past, refuse an `=` token that is
 *    not a registered flag: the unknown-flag validator stops at `--`;
 *  - refuse an empty value or one that looks like a flag (`-y`, `--x`);
 *  - keep the token where the handler on this path reads the `=` form
 *    (EQUALS_READERS, keyed by command or `command sub`);
 *  - split `--flag value` when the command's own table declares a value;
 *  - refuse every other `=` form with the separate-token spelling. Splitting
 *    a flag the subcommand never reads would leave its value as a stray
 *    positional, which handlers that take the first numeric or non-flag token
 *    as their target would act on (`forget --purge --reason=3 34` purging
 *    fact 3). Keeping it whole is safe only where every path of the command
 *    reads the `=` form, and evidence from one module does not show that for
 *    its sibling subcommands (`extract links --source-id=x` walked every
 *    source while `extract --stale` validated the same token).
 * `--json=true` becomes `--json` (the agent contract's JSON spelling, read
 * the same way by jsonRequested). Refusals name `--flag=…`, never the value,
 * which may be a credential. A short flag never takes `=` (`-y=n` is refused,
 * never taken as consent). OWN_EQUALS_PARSERS pass their argv through,
 * unregistered flags keep the token for the validator to name, and a bare
 * `--` ends the scan only on a path whose handler stops there (END_OF_OPTIONS,
 * keyed by `command sub`): `serve`, `auth`, `frontmatter generate` and
 * `questions` read flags after it.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';
import { usageError } from './cli-error.ts';
import { loadCuratedHelp } from './help/render.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { SYNC_FLAGS } from '../core/sync-flags.ts';

/**
 * Where the handler on a path reads the `=` form itself, keyed by command or
 * `command sub` (the narrowest key every path under it honors): the token is
 * kept as written. Pinned by test/cli-flag-equals.test.ts against every module
 * that reads an `=` form.
 */
export const EQUALS_READERS: Readonly<Record<string, readonly string[]>> = {
  // beliefs.ts:61 sourceArg runs before the sub branch (beliefs.ts:98) for every subcommand.
  beliefs: ['--source'],
  // beliefs.ts:52 beliefsChangesArgs (also the thin-client route, thin-client-routing.ts:85).
  'beliefs changes': ['--since'],
  // beliefs-replay-purges.ts:14 flag() reads --x v and --x=v.
  'beliefs replay-purges': ['--archived-at', '--purge-mirror', '--from-url-env'],
  // capture.ts:96 regex; every other = form is refused by capture's own parser (capture.ts:132).
  capture: ['--request-id', '--expected-revision'],
  // check-resolvable.ts:120 parseFlags.
  'check-resolvable': ['--skills-dir'],
  // code-scope.ts:64 parseFlag (code-callees.ts:46-48, code-callers.ts:58-60, code-def.ts:166-172, code-refs.ts:109-115).
  'code-callees': ['--limit', '--source'],
  'code-callers': ['--limit', '--source'],
  'code-def': ['--limit', '--lang', '--source'],
  'code-refs': ['--limit', '--lang', '--source'],
  // compile-context.ts:74 flagValue (parseCompileFlags :88-115).
  'compile-context': ['--target', '--budget', '--include', '--out', '--source'],
  // core/consent.ts:112 parseConsentFlags via enableConsent (decide.ts:348, effects paid); decide reads no --max-* itself.
  'decide enable': ['--max-usd', '--max-cost'],
  // doctor.ts:417 --scope=brain only (=-only); doctor/budget.ts:68 --tier/--budget-ms; cli/commands/doctor.ts:27 --tier (thin client);
  // doctor/registry.ts:332 --only; check-resolvable.ts:120 --skills-dir via doctor.ts:460; core/consent.ts:130 --expect (remediate-consent.ts:133).
  doctor: ['--scope', '--tier', '--budget-ms', '--only', '--skills-dir', '--expect'],
  // edge-proposals.ts:81 flag() used only by list (:91,:93); other subs take the first numeric token as the id (:86).
  'edge-proposals list': ['--status', '--limit'],
  // embed.ts:841 parsePaceArgs (--pace bare or =mode); core/consent.ts:126 via embed-consent.ts:129 and held-embedding.ts:234.
  embed: ['--pace', '--pace-max-concurrency', '--max-usd', '--max-cost'],
  // eval-conversation-parser.ts:48-53 (main.ts:2216 and eval.ts:106 both reach it).
  'eval conversation-parser': ['--fixtures', '--min-recall'],
  // eval/decide-eval-flags.ts:124 extractDecideEvalFlags via eval-retrieval-quality.ts:38.
  'eval retrieval-quality': ['--decide', '--decide-provider', '--decide-calibration', '--decide-threshold', '--decide-force-on', '--decide-dataset'],
  // eval-takes-quality.ts:82 getFlag; union over run (:148-162) / trend (:200-201) / regress (:212-226); replay reads none.
  'eval takes-quality': ['--limit', '--cycles', '--budget-usd', '--slug-prefix', '--models', '--source', '--rubric-version', '--against', '--threshold'],
  // export.ts:18 option() (:95-99).
  export: ['--dir', '--source', '--type', '--slug-prefix', '--repo'],
  // core/consent.ts:126 via requireEmbedBackfillConsent (features.ts:306, --auto-fix paid fixes only).
  features: ['--max-usd', '--max-cost'],
  // recall.ts:1183-1188 runForget (plain) and forget-purge.ts:44 flagValue (:114-123, purge); --match is purge-only, ignored by plain forget in any form.
  forget: ['--request-id', '--source', '--match'],
  // frontmatter.ts:356 runValidate.
  'frontmatter validate': ['--path'],
  // frontmatter.ts:667 runAudit.
  'frontmatter audit': ['--source'],
  // frontmatter-install-hook.ts:184.
  'frontmatter install-hook': ['--source'],
  // graph-query.ts:56.
  'graph-query': ['--source'],
  // import.ts:377-395 readSourceFlag (+ :237 keyless refusal).
  import: ['--source', '--source-id'],
  // integrity.ts:857 extractFlag via cmdCheck (:306-307); integrity auto is STRICT.
  'integrity check': ['--limit', '--type'],
  // jobs/shared.ts:121 parseJobIsolationFlag via jobs/supervisor.ts:165.
  'jobs supervisor': ['--job-isolation'],
  // jobs/watch.ts:11 reads only --refresh-ms=N.
  'jobs watch': ['--refresh-ms'],
  // lint.ts:929 runLint.
  lint: ['--exclude'],
  // migrate-graduation.ts:97 flagValue (parseGraduationArgs :121-151); graduation-only flags, the legacy copier (migrate-engine.ts) never reads them.
  migrate: ['--url-env', '--trigger-bypass', '--drain-timeout', '--batch-size', '--expect'],
  // models.ts:853 doctor mode only (sub selection :817), repeated --skip=<provider>, =-only.
  'models doctor': ['--skip'],
  // core/bounded-listing-cli.ts:15 parseListingFlags via orphans.ts:353.
  orphans: ['--limit', '--cursor'],
  // pages-purges.ts:12 flagValue (:21) for purges and unpurge.
  'pages purges': ['--source'],
  'pages unpurge': ['--source'],
  // pages-unsearchable.ts:34 flagValue (:42-52).
  'pages unsearchable': ['--state', '--limit', '--source'],
  // pages-ghosts.ts:24.
  'pages ghosts': ['--source'],
  // pages-status.ts:77 parsePagesStatusArgs.
  'pages status': ['--source'],
  // recall.ts:156-201 parseFlags (--entity both, --source-id=, --question=, --budget-policy= with empty-value refusal).
  recall: ['--entity', '--source-id', '--question', '--budget-policy'],
  // reindex.ts:155-163 normalizeReindexArgs at entry (cli/commands/reindex.ts:12); --max-cost via core/consent.ts:126 (reindex-consent.ts:77).
  reindex: ['--type', '--limit', '--repo', '--workers', '--concurrency', '--max-usd', '--max-cost'],
  // core/consent.ts:126 via reindex-code.ts:503 / reindex-code-delegate.ts:51 (paid); reindex-code reads no --max-usd itself.
  'reindex-code': ['--max-usd'],
  // resolvers.ts:172 extractFlag via cmdList (:66-67).
  'resolvers list': ['--cost', '--backend'],
  // routing-eval.ts:83 parseFlags.
  'routing-eval': ['--skills-dir'],
  // schema.ts:457 parseFlags; only these subs use the parsed source (:208,:499,:542,:562,:872,:1043,:1080,:1103).
  'schema active': ['--source', '--source-id'],
  'schema detect': ['--source', '--source-id'],
  'schema suggest': ['--source', '--source-id'],
  'schema review-candidates': ['--source', '--source-id'],
  'schema review-orphans': ['--source', '--source-id'],
  'schema stats': ['--source', '--source-id'],
  'schema cardinality-preview': ['--source', '--source-id'],
  'schema sync': ['--source', '--source-id'],
  // schema.ts:765 runLintCmd strips both forms through parseFlags before util.parseArgs.
  'schema lint': ['--source', '--source-id'],
  // schema.ts:1138 runReloadCmd; schema.ts:1004 pickPackName for the pack-authoring subs (remove-* are STRICT, add-type is OWN).
  'schema reload': ['--pack'],
  'schema update-type': ['--pack'],
  'schema add-alias': ['--pack'],
  'schema add-prefix': ['--pack'],
  'schema add-link-type': ['--pack'],
  'schema set-extractable': ['--pack'],
  'schema set-expert-routing': ['--pack'],
  'schema scaffold-extractable': ['--pack'],
  // skillify.ts:117 parseScaffoldFlags (:142-160); skillify check reads no = form.
  'skillify scaffold': ['--description', '--triggers', '--writes-to', '--skills-dir'],
  // skillpack.ts:312 cmdStatus, :382 cmdSync, :501 cmdMigrateFence, :547 cmdScrubLegacy, :1210 cmdHarvest, :1281-1287 cmdDiff.
  'skillpack status': ['--workspace'],
  'skillpack sync': ['--workspace'],
  'skillpack migrate-fence': ['--workspace'],
  'skillpack scrub-legacy-fence-rows': ['--workspace'],
  'skillpack harvest': ['--from'],
  'skillpack diff': ['--workspace', '--skills-dir'],
  // skillpack/scaffold.ts:36 lane select + :73 --workspace=; harness lane skillpack/harness.ts:91-158 parseHarnessArgs (:364).
  'skillpack scaffold': ['--workspace', '--harness', '--persona', '--skill', '--dest', '--scope', '--skills'],
  // skillpack/reference.ts:44 harness lane (strict-args.ts:105 makes the non-harness lane STRICT); harness.ts:542.
  'skillpack reference': ['--harness', '--persona', '--skill', '--dest', '--scope', '--workspace', '--skills'],
  // core/bounded-listing-cli.ts:15 via sources.ts:1213 runStatus (+ :1214 paged regex).
  'sources status': ['--limit', '--cursor'],
  // sources-harden.ts:31 flagVal: runHarden (:83-84), runPull (:150-151). `sources pull --path=` refuses: main.ts takes the database-free route only on the exact token.
  'sources harden': ['--branch', '--pat-file'],
  'sources pull': ['--branch'],
  // status.ts:812 parseDeadlineFlag, :834 parseSectionFlag (runStatus :871-881).
  status: ['--section', '--deadline-ms'],
  // core/bounded-listing-cli.ts:15 via sync/operator.ts:167 holdsListing (+ :173 sized check).
  'sync status': ['--limit', '--cursor'],
  // trust-claim.ts:65 flagValues (:81, :113).
  'trust claim-sources': ['--source'],
  // core/stable-channel.ts:19 parseChannelArg via upgrade.ts:361.
  upgrade: ['--channel'],
};

/**
 * Commands and subcommands whose handler parses `--flag value` and
 * `--flag=value` itself on every path, refusing `=` on its own switches:
 * cliOnlyFlagArgs in src/cli/main.ts passes their argv through unchanged
 * (pinned by test/cli-flag-equals.test.ts in both directions against every
 * `indexOf('=')` option parser). The sources lifecycle subcommands are not
 * here: on an unmanaged brain they fall back to runSources, which reads only
 * exact tokens.
 */
export const OWN_EQUALS_PARSERS: ReadonlySet<string> = new Set([
  'append', 'auth local-writer', 'eval longmemeval', 'git', 'migrate embeddings', 'repair', 'retrieval-upgrade', 'schema add-type', 'skillpack remove',
  'sources connect', 'sources inspect', 'sources reconcile', 'sources reset-upstream', 'sources writer',
  'takes add', 'takes remove', 'takes resolve', 'takes supersede', 'takes update',
]);

/** Switches a command reads with `args.includes` whose name takes a value elsewhere; the command's own reading wins. */
export const COMMAND_SWITCHES: Readonly<Record<string, readonly string[]>> = {
  sync: ['--detail'],
  schema: ['--fields'],
};

/** Paths (`command sub`) whose handler treats a bare `--` as the end of its options; everywhere else the scan continues past it. */
export const END_OF_OPTIONS: ReadonlySet<string> = new Set(['agent run', 'frontmatter validate']);

/** Switch evidence by name: shared-op boolean parameters (handler-free manifest) and boolean flags in any command's curated help. Loaded only when an `=` token needs it. */
let switches: Promise<ReadonlySet<string>> | undefined;
export function knownSwitches(): Promise<ReadonlySet<string>> {
  return switches ??= (async () => {
    const out = new Set<string>();
    for (const op of OPERATION_MANIFEST) for (const [name, p] of Object.entries(op.params)) if (p.type === 'boolean') out.add(`--${name.replace(/_/g, '-')}`);
    for (const command of Object.keys(CLI_FLAG_REGISTRY)) for (const f of (await loadCuratedHelp(command))?.flags ?? []) if (f.type === 'boolean') out.add(f.name);
    return out;
  })();
}

const EQUALS_TOKEN = /^(--[a-z0-9][a-z0-9-]*|-[A-Za-z])=([\s\S]*)$/;

export async function splitFlagEquals(command: string, args: readonly string[]): Promise<{ args: string[] } | { refusal: OperationError }> {
  if (!args.some(a => /^-[^=\s]*=/.test(a))) return { args: [...args] };
  const legal = CLI_FLAG_REGISTRY[command];
  const readers = [...EQUALS_READERS[command] ?? [], ...EQUALS_READERS[`${command} ${args[0]}`] ?? []];
  let types: Map<string, string> | undefined;
  const out: string[] = [];
  let pastDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--' && END_OF_OPTIONS.has(`${command} ${args[0]}`)) return { args: [...out, ...args.slice(i)] };
    pastDashDash ||= token === '--';
    const m = EQUALS_TOKEN.exec(token);
    const flag = m?.[1];
    if (flag !== undefined && !flag.startsWith('--')) {
      return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: a short flag takes no =.`, `Write ${flag} on its own, or ${flag} <value> with the value as the next argument.`) };
    }
    const registered = flag !== undefined && (!legal || legal.includes(flag) || flag.startsWith('--no-') && legal.includes(`--${flag.slice(5)}`));
    const unvalidated = pastDashDash && !registered && /^--[^=\s]+=/.exec(token);
    if (unvalidated) return { refusal: usageError(`gbrain ${command}: \`${unvalidated[0]}…\`: not a flag of this command, and its handler reads flags after --.`, 'Check the spelling: flags are lowercase words joined by hyphens.') };
    if (!m || !registered || readers.includes(flag)) { out.push(token); continue; }
    const value = m[2]!;
    if (flag === '--json' && value === 'true') { out.push(flag); continue; }
    types ??= new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type]));
    const own = types.get(flag) ?? (command === 'sync' ? (SYNC_FLAGS as Record<string, { arity: string }>)[flag]?.arity : undefined);
    const isSwitch = own !== undefined ? own === 'boolean' : flag.startsWith('--no-') || COMMAND_SWITCHES[command]?.includes(flag) || (await knownSwitches()).has(flag);
    const refusal = isSwitch
      ? [`${flag} is a switch and takes no value`, `Write ${flag} on its own, or leave it out.`]
      : value === '' || /^-[-A-Za-z]/.test(value)
        ? [`the value is empty or looks like a flag`, `Write ${flag} <value> with the value as the next argument.`]
        : own === undefined && /^(true|false|yes|no|y|n|on|off)$/i.test(value)
          ? [`${flag} takes no true/false value`, `Write ${flag} on its own to turn it on, or leave it out to turn it off.`]
          : own === undefined
          ? [`this command takes ${flag} <value> as two arguments`, `Write ${flag} <value>, or ${flag} on its own if it is a switch.`]
          : null;
    if (refusal) return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: ${refusal[0]}.`, refusal[1]!) };
    out.push(flag, value);
  }
  return { args: out };
}

/** A command module's direct `bun run` entry: main's pass-through for own `=` parsers, the `=` rule, and main's unknown-flag check (which stops at `--`). */
export async function directEntryArgs(command: string, raw: string[]): Promise<{ args: string[] } | { refusal: OperationError }> {
  if (OWN_EQUALS_PARSERS.has(`${command} ${raw[0]}`)) return { args: raw };
  const split = await splitFlagEquals(command, raw);
  if ('refusal' in split) return split;
  const legal = new Set(CLI_FLAG_REGISTRY[command]);
  const end = split.args.indexOf('--');
  const unknown = split.args.slice(0, end < 0 ? undefined : end).map(a => /^--[^=\s]+/.exec(a)?.[0]).find(f => f && !legal.has(f) && !(f.startsWith('--no-') && legal.has(`--${f.slice(5)}`)));
  return unknown ? { refusal: usageError(`gbrain ${command}: unknown flag ${unknown}.`, `Run gbrain ${command} --help for the flags it takes.`) } : split;
}
