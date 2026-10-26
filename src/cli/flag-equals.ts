/**
 * #7619: `--flag=value` on CLI_ONLY commands. The unknown-flag validator
 * accepts the `=` form of every registered flag, but most handlers read only
 * `--flag value` (`args.includes`, `args[args.indexOf(flag) + 1]`), so the
 * value was dropped with no error: `serve --access=read-only` served every
 * write tool. The CLI entry splits each token once, before validation and
 * dispatch, so every handler sees the form it reads. Where splitting could
 * change the meaning, the `=` form is refused (invalid_params, exit 2) with
 * the separate-token spelling:
 *  - a switch (a curated boolean, or a `--no-` negation) takes no value;
 *  - a flag whose arity is unknown, given a switch-like value
 *    (true/false/yes/no/on/off/0/1): split, `--yes=false` would turn it on;
 *  - an empty value, or one starting with `--` (it would read as the next
 *    flag or as end-of-options).
 * Flags in EQUALS_FORM_READERS keep the token: their handler reads the `=`
 * form itself and gives it a meaning the bare form does not have. An unknown
 * flag keeps the token too, so the validator names it. Everything after a
 * bare `--` is passthrough.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';
import { usageError } from './cli-error.ts';
import type { CliHelpSpec } from './command-table.ts';

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
};

const SWITCH_VALUE = /^(?:true|false|yes|no|on|off|0|1)$/i;

export function splitFlagEquals(command: string, args: readonly string[], curated: CliHelpSpec | null): { args: string[] } | { refusal: OperationError } {
  const legal = CLI_FLAG_REGISTRY[command];
  const types = new Map(curated?.flags.map(f => [f.name, f.type]));
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') return { args: [...out, ...args.slice(i)] };
    const m = /^(--[a-z0-9][a-z0-9-]*)=([\s\S]*)$/.exec(token);
    const flag = m?.[1];
    const known = flag !== undefined && (!legal || legal.includes(flag) || flag.startsWith('--no-') && legal.includes(`--${flag.slice(5)}`));
    if (!m || !known || EQUALS_FORM_READERS[command]?.includes(flag)) { out.push(token); continue; }
    const value = m[2]!;
    const type = types.get(flag);
    const refusal = type === 'boolean' || flag.startsWith('--no-')
      ? [`${flag} is a switch and takes no value`, `Write ${flag} on its own, or leave it out.`]
      : value === '' || value.startsWith('--')
        ? [`the value is empty or begins with --`, `Write ${flag} <value> with the value as the next argument.`]
        : type === undefined && SWITCH_VALUE.test(value)
          ? [`${flag} could be a switch or take a value, so the = form is ambiguous`, `Write ${flag} on its own to turn a switch on, or ${flag} ${value} to pass the value.`]
          : null;
    if (refusal) return { refusal: usageError(`gbrain ${command}: \`${token}\`: ${refusal[0]}.`, refusal[1]!) };
    out.push(flag, value);
  }
  return { args: out };
}
