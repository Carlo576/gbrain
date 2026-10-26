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
 *    the value (`--dry-run=true` would write);
 *  - refuse an empty value or one that looks like a flag (`-y`, `--x`);
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
 * which may be a credential. OWN_EQUALS_PARSERS pass their argv through,
 * EQUALS_FORM_READERS keep the token for the few handlers that read only the
 * `=` form, unregistered flags keep it for the validator to name, and
 * everything after a bare `--` is passthrough.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';
import { usageError } from './cli-error.ts';
import type { CliHelpSpec } from './command-table.ts';
import { loadCuratedHelp } from './help/render.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { SYNC_FLAGS } from '../core/sync-flags.ts';

export const EQUALS_FORM_READERS: Readonly<Record<string, readonly string[]>> = {
  // doctor.ts reads only `--scope=brain`.
  doctor: ['--scope'],
  // parsePaceArgs: bare `--pace` is balanced, `--pace=<mode>` picks the mode.
  embed: ['--pace'],
  // jobs watch reads only `--refresh-ms=N`.
  jobs: ['--refresh-ms'],
  // models doctor reads only repeated `--skip=<provider>`.
  models: ['--skip'],
  // recall parses both forms and refuses an empty `--budget-policy=` naming the policies.
  recall: ['--budget-policy'],
  // edge-proposals reads `--status=X` itself; `--status` is a switch on other commands.
  'edge-proposals': ['--status'],
};

/**
 * Commands and subcommands whose handler parses `--flag value` and
 * `--flag=value` itself, refusing `=` on its own switches: cliOnlyFlagArgs in
 * src/cli/main.ts passes their argv through unchanged (pinned by
 * test/cli-flag-equals.test.ts against every `indexOf('=')` option parser).
 */
export const OWN_EQUALS_PARSERS: ReadonlySet<string> = new Set([
  'append', 'auth local-writer', 'eval longmemeval', 'git', 'migrate embeddings', 'repair', 'retrieval-upgrade', 'schema add-type', 'skillpack remove',
  'sources add', 'sources archive', 'sources connect', 'sources inspect', 'sources purge', 'sources reclone', 'sources reconcile',
  'sources remove', 'sources reset-upstream', 'sources restore', 'sources set-path', 'sources writer',
  'takes add', 'takes remove', 'takes resolve', 'takes supersede', 'takes update',
]);

/** Switches a command reads with `args.includes` whose name takes a value elsewhere; the command's own reading wins. */
export const COMMAND_SWITCHES: Readonly<Record<string, readonly string[]>> = {
  sync: ['--detail'],
  schema: ['--fields'],
};

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

export const EQUALS_TOKEN = /^(--[a-z0-9][a-z0-9-]*)=([\s\S]*)$/;

export function splitFlagEquals(command: string, args: readonly string[], curated: CliHelpSpec | null, known: ReadonlySet<string>): { args: string[] } | { refusal: OperationError } {
  const legal = CLI_FLAG_REGISTRY[command];
  const types = new Map(curated?.flags.map(f => [f.name, f.type]));
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') return { args: [...out, ...args.slice(i)] };
    const m = EQUALS_TOKEN.exec(token);
    const flag = m?.[1];
    const registered = flag !== undefined && (!legal || legal.includes(flag) || flag.startsWith('--no-') && legal.includes(`--${flag.slice(5)}`));
    if (!m || !registered || EQUALS_FORM_READERS[command]?.includes(flag)) { out.push(token); continue; }
    const value = m[2]!;
    if (flag === '--json' && value === 'true') { out.push(flag); continue; }
    const own = types.get(flag) ?? (command === 'sync' ? (SYNC_FLAGS as Record<string, { arity: string }>)[flag]?.arity : undefined);
    const isSwitch = own !== undefined ? own === 'boolean' : flag.startsWith('--no-') || COMMAND_SWITCHES[command]?.includes(flag) || known.has(flag);
    const refusal = isSwitch
      ? [`${flag} is a switch and takes no value`, `Write ${flag} on its own, or leave it out.`]
      : value === '' || /^-[-A-Za-z]/.test(value)
        ? [`the value is empty or looks like a flag`, `Write ${flag} <value> with the value as the next argument.`]
        : own === undefined
          ? [`this command reads ${flag} only as a separate argument`, `Write ${flag} <value>, or ${flag} on its own if it is a switch.`]
          : null;
    if (refusal) return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: ${refusal[0]}.`, refusal[1]!) };
    out.push(flag, value);
  }
  return { args: out };
}
