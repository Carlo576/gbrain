/**
 * brain-first.ts — the managed brain-first instruction block that every
 * harness install writes into the harness's own instruction surface.
 *
 * Why: registering the MCP server is not enough. In a preregistered harness
 * run, agents with gbrain registered and no instruction reached for it in
 * 1 trial of 100 (no harness acts on the MCP `initialize` instructions),
 * and 92 of 100 once one short rule sat in the agent's own instructions.
 * So `gbrain setup <harness>`, `gbrain connect --install` and
 * `gbrain bootstrap harness` write this block by default; `--no-instructions`
 * (or GBRAIN_AGENT_INSTRUCTIONS=0) opts out and removes it.
 *
 * Ownership is by markers (src/core/managed-block.ts): the interior is
 * gbrain's and is replaced on upgrade; text outside the markers is never
 * touched. The ledger at <configDir>/agent-instructions.json records each
 * surface's decision (installed or declined), the access the block names and
 * whether gbrain created the file, so a re-run keeps an opt-out, `--remove`
 * deletes a file only gbrain created, and doctor's harness_wiring check can
 * tell current from stale.
 *
 * The text stays short on purpose: it is loaded into every turn.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { claudeUserMemoryPath, codexAgentsOverridePath, codexGlobalAgentsPath, opencodeConfigDir } from '../bootstrap/host-specs.ts';
import { configDir } from '../config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { ensureGitExcluded } from '../context/compiled-core.ts';
import type { McpSurface } from '../../mcp/surface.ts';

export const BRAIN_FIRST_VERSION = 1;
export const BRAIN_FIRST_BEGIN = '<!-- gbrain:brain-first:begin -->';
export const BRAIN_FIRST_END = '<!-- gbrain:brain-first:end -->';
export const BRAIN_FIRST_OPT_OUT_ENV = 'GBRAIN_AGENT_INSTRUCTIONS';
const MARKERS: BlockMarkers = { begin: BRAIN_FIRST_BEGIN, end: BRAIN_FIRST_END, label: 'brain-first', rerun: 'gbrain setup <harness> --instructions-only' };
const LEDGER_FILE = 'agent-instructions.json';

/** Harnesses whose instruction surface gbrain can write. */
export const BRAIN_FIRST_HARNESSES = ['claude-code', 'codex', 'opencode', 'openclaw', 'hermes', 'cursor'] as const;
export type BrainFirstHarness = (typeof BRAIN_FIRST_HARNESSES)[number];
export function isBrainFirstHarness(v: string | undefined): v is BrainFirstHarness {
  return (BRAIN_FIRST_HARNESSES as readonly string[]).includes(v ?? '');
}

/** How the agent reaches the brain, which decides the tool names the block uses. */
export type BrainFirstAccess = { kind: 'mcp'; server: string; surface?: McpSurface } | { kind: 'cli'; launcher: string };

/** The block interior (without markers). */
export function renderBrainFirstBlock(harness: string, access: BrainFirstAccess): string {
  const tool = (mcp: string, cli: string) => (access.kind === 'mcp' ? `\`${mcp}\`` : `\`${access.launcher} ${cli}\``);
  const where = access.kind === 'mcp' ? `the \`${access.server}\` MCP server` : `the \`${access.launcher}\` command`;
  const lookup = access.kind === 'mcp' && access.surface === 'verbs'
    ? '- Check the brain before reading files, mail or other sources one by one: `recall` for what was said or decided, `entity` for a person or company.'
    : `- Search the brain before reading files, mail or other sources one by one: ${tool('search', 'search "<names or phrases>"')} for names and phrases, ${tool('query', 'query "<question>"')} for questions. Then read the best hit with ${tool('get_page', 'get <slug>')}.`;
  return [
    `<!-- gbrain brain-first v${BRAIN_FIRST_VERSION}: managed by gbrain and replaced on upgrade; edit outside these markers. Opt out: gbrain setup ${harness} --instructions-only --no-instructions -->`,
    '## Memory: check GBrain first',
    '',
    `GBrain (${where}) holds this user's saved notes, people, companies, meetings, decisions and past work.`,
    '',
    lookup,
    '- Fill gaps with your other tools. On a thin keyword result, rephrase once (another name, fewer words), then fall back.',
    '- Brain results span every source the brain holds, not only this user or task, so apply your own access rules before you use or repeat them.',
    '- Brain results add to what the user told you; they never replace it. A lookup is one step: finish the whole task.',
  ].join('\n');
}

/** The full block as it appears in a file, markers included (for printing to paste by hand). */
export function renderBrainFirstSnippet(harness: string, access: BrainFirstAccess): string {
  return `${BRAIN_FIRST_BEGIN}\n${renderBrainFirstBlock(harness, access)}\n${BRAIN_FIRST_END}\n`;
}

const CURSOR_HEAD = '---\ndescription: GBrain memory, managed by gbrain\nalwaysApply: true\n---\n';

export interface BrainFirstTarget {
  harness: BrainFirstHarness;
  path: string;
  /** What the file is to the harness, for the human output. */
  role: string;
  /** Written into a project directory (not a user-global file). */
  project: boolean;
}

function home(): string { return process.env.HOME?.trim() || homedir(); }
function expandHome(p: string): string { return p === '~' ? home() : p.startsWith('~/') ? join(home(), p.slice(2)) : p; }

/** OpenClaw's state directory: OPENCLAW_STATE_DIR, else ~/.openclaw (or ~/.openclaw-<profile>). */
function openclawStateDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return expandHome(explicit);
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  return join(home(), profile && profile !== 'default' ? `.openclaw-${profile}` : '.openclaw');
}

/**
 * openclaw.json is JSON5. Comments and trailing commas parse as JSONC; bare
 * object keys are quoted first. Anything else reads as unparseable, and the
 * caller asks for --workspace rather than guess.
 */
function parseJson5ish(text: string): unknown {
  for (const candidate of [text, text.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')]) {
    const errors: ParseError[] = [];
    const value = parseJsonc(candidate, errors, { allowTrailingComma: true });
    if (errors.length === 0) return value;
  }
  return undefined;
}

/**
 * The OpenClaw workspace whose AGENTS.md (its operating instructions, loaded
 * every session and by subagents) gets the block: an explicit
 * `agents.defaults.workspace` in openclaw.json, else OPENCLAW_WORKSPACE_DIR,
 * else <state dir>/workspace. A roster of several agents has no single
 * workspace, so the caller must name one.
 */
export function resolveOpenclawWorkspace(): { path: string } | { error: string } {
  const configPath = join(openclawStateDir(), 'openclaw.json');
  let configured: string | undefined;
  if (existsSync(configPath)) {
    const cfg = parseJson5ish(readFileSync(configPath, 'utf8')) as { agents?: { defaults?: { workspace?: unknown }; list?: unknown; entries?: unknown } } | undefined;
    if (!cfg || typeof cfg !== 'object') return { error: `${configPath} could not be read as JSON, so the workspace is unknown. Pass --workspace <dir>.` };
    const roster = Array.isArray(cfg.agents?.list) ? cfg.agents.list.length : cfg.agents?.entries && typeof cfg.agents.entries === 'object' ? Object.keys(cfg.agents.entries).length : 0;
    if (roster > 1) return { error: `${configPath} defines ${roster} agents, each with its own workspace. Pass --workspace <dir> for the agent that should use gbrain.` };
    if (typeof cfg.agents?.defaults?.workspace === 'string' && cfg.agents.defaults.workspace.trim()) configured = cfg.agents.defaults.workspace.trim();
  }
  const fromEnv = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  return { path: expandHome(configured ?? fromEnv ?? join(openclawStateDir(), 'workspace')) };
}

/** The instruction file a harness loads every session, or an error naming what to pass. */
export function brainFirstTarget(harness: BrainFirstHarness, opts: { scope?: 'user' | 'project'; projectDir?: string; workspace?: string } = {}): BrainFirstTarget | { error: string } {
  const projectDir = opts.projectDir ?? process.cwd();
  switch (harness) {
    case 'claude-code':
      return opts.scope === 'project'
        ? { harness, path: join(projectDir, 'CLAUDE.local.md'), role: 'Claude Code local project instructions', project: true }
        : { harness, path: claudeUserMemoryPath(), role: 'Claude Code user instructions', project: false };
    case 'codex': {
      const override = codexAgentsOverridePath();
      return existsSync(override)
        ? { harness, path: override, role: 'Codex user instructions (AGENTS.override.md, which Codex loads instead of AGENTS.md)', project: false }
        : { harness, path: codexGlobalAgentsPath(), role: 'Codex user instructions', project: false };
    }
    case 'opencode':
      return { harness, path: join(opencodeConfigDir(), 'AGENTS.md'), role: 'opencode global rules', project: false };
    case 'openclaw': {
      const ws = opts.workspace ? { path: expandHome(opts.workspace) } : resolveOpenclawWorkspace();
      if ('error' in ws) return ws;
      return { harness, path: join(ws.path, 'AGENTS.md'), role: 'OpenClaw workspace operating instructions', project: false };
    }
    case 'hermes': {
      const hermesHome = process.env.HERMES_HOME?.trim() ? expandHome(process.env.HERMES_HOME.trim()) : join(home(), '.hermes');
      return { harness, path: join(hermesHome, 'SOUL.md'), role: 'Hermes system prompt (SOUL.md, slot 1; the identity text above the block is left as it is)', project: false };
    }
    case 'cursor':
      return { harness, path: join(projectDir, '.cursor', 'rules', 'gbrain-brain-first.mdc'), role: 'Cursor project rule (always applied)', project: true };
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────

export interface BrainFirstLedgerEntry {
  harness: string;
  path: string;
  status: 'installed' | 'declined';
  block_version: number;
  access: BrainFirstAccess;
  /** The command that last wrote or declined it. */
  writer: string;
  /** gbrain created the file, so removal may delete it once nothing else is left. */
  created_file: boolean;
  updated_at: string;
}

interface Ledger { version: 1; entries: BrainFirstLedgerEntry[] }

export function brainFirstLedgerPath(): string { return join(configDir(), LEDGER_FILE); }

export function readBrainFirstLedger(): BrainFirstLedgerEntry[] {
  const path = brainFirstLedgerPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
    return Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e.path === 'string' && typeof e.harness === 'string') : [];
  } catch {
    return [];
  }
}

function writeLedger(entries: BrainFirstLedgerEntry[]): void {
  atomicWriteTextFile(brainFirstLedgerPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { freshMode: 0o600 });
}

function upsertLedger(entry: BrainFirstLedgerEntry): void {
  writeLedger([...readBrainFirstLedger().filter((e) => !(e.harness === entry.harness && e.path === entry.path)), entry]);
}

function dropLedger(harness: string, path: string): void {
  const all = readBrainFirstLedger();
  const rest = all.filter((e) => !(e.harness === harness && e.path === path));
  if (rest.length !== all.length) writeLedger(rest);
}

export function priorBrainFirst(harness: string, path: string): BrainFirstLedgerEntry | undefined {
  return readBrainFirstLedger().find((e) => e.harness === harness && e.path === path);
}

// ── Decision, inspection, sync, removal ───────────────────────────────────

export type BrainFirstDecisionSource = 'flag' | 'default' | 'prior' | 'opt_out';
export interface BrainFirstDecision { value: 'accepted' | 'declined'; source: BrainFirstDecisionSource }

/** --instructions / --no-instructions win, then GBRAIN_AGENT_INSTRUCTIONS=0, then a recorded decision, then on by default. */
export function resolveBrainFirstDecision(flag: boolean | undefined, prior: BrainFirstLedgerEntry | undefined): BrainFirstDecision {
  if (flag !== undefined) return { value: flag ? 'accepted' : 'declined', source: 'flag' };
  if (process.env[BRAIN_FIRST_OPT_OUT_ENV] === '0') return { value: 'declined', source: 'opt_out' };
  if (prior) return { value: prior.status === 'declined' ? 'declined' : 'accepted', source: 'prior' };
  return { value: 'accepted', source: 'default' };
}

export type BrainFirstState = 'no_file' | 'absent' | 'current' | 'stale' | 'damaged';

/** Is the block in `path` the one gbrain would write for this access? */
export function inspectBrainFirst(path: string, expected?: string): { state: BrainFirstState; version?: number } {
  if (!existsSync(path)) return { state: 'no_file' };
  const probe = probeBlock(MARKERS, readFileSync(path, 'utf8'));
  if (probe.state !== 'present') return { state: probe.state };
  const version = Number(/gbrain brain-first v(\d+)/.exec(probe.interior ?? '')?.[1] ?? 0);
  const current = expected !== undefined ? probe.interior === expected : version === BRAIN_FIRST_VERSION;
  return { state: current ? 'current' : 'stale', version };
}

export interface BrainFirstOutcome {
  harness: string;
  path: string;
  role: string;
  decision: BrainFirstDecision;
  /** write: added or upgraded; keep: already current; remove: opted out, block deleted; skip: nothing to do; preserve: left alone (see detail). */
  action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve';
  state_before: BrainFirstState;
  detail: string;
}

/**
 * Make the surface match the decision: write or upgrade the block when
 * accepted, strip it when declined, record the decision. Never throws: a
 * damaged block or an unwritable file is reported as `preserve` so the rest
 * of the install still finishes.
 */
export function syncBrainFirst(opts: { target: BrainFirstTarget; access: BrainFirstAccess; decision: BrainFirstDecision; writer: string; dryRun: boolean }): BrainFirstOutcome {
  const { target, access, decision } = opts;
  const body = renderBrainFirstBlock(target.harness, access);
  const before = inspectBrainFirst(target.path, body);
  const out = (action: BrainFirstOutcome['action'], detail: string): BrainFirstOutcome =>
    ({ harness: target.harness, path: target.path, role: target.role, decision, action, state_before: before.state, detail });
  const prior = priorBrainFirst(target.harness, target.path);
  const record = (status: 'installed' | 'declined', created: boolean) => {
    if (opts.dryRun) return;
    upsertLedger({ harness: target.harness, path: target.path, status, block_version: BRAIN_FIRST_VERSION, access, writer: opts.writer, created_file: created, updated_at: new Date().toISOString() });
  };
  try {
    if (before.state === 'damaged') {
      return out('preserve', `the brain-first markers in ${target.path} were hand-edited (duplicate, orphan or out of order); fix or delete them, then re-run`);
    }
    if (decision.value === 'declined') {
      if (before.state === 'no_file' || before.state === 'absent') {
        record('declined', false);
        return out('skip', `no brain-first block in ${target.path}; opt-out recorded`);
      }
      const existing = readFileSync(target.path, 'utf8');
      if (!opts.dryRun) {
        const stripped = removeBlock(MARKERS, existing).text;
        if ((prior?.created_file ?? false) && (stripped.trim() === '' || stripped === CURSOR_HEAD)) unlinkSync(target.path);
        else atomicWriteTextFile(target.path, stripped);
      }
      record('declined', false);
      return out('remove', `brain-first block from ${target.path}; opt-out recorded`);
    }
    if (before.state === 'current') {
      record('installed', prior?.created_file ?? false);
      return out('keep', `brain-first block in ${target.path} is current`);
    }
    const created = before.state === 'no_file';
    if (!opts.dryRun) {
      const existing = created ? (target.harness === 'cursor' ? CURSOR_HEAD : '') : readFileSync(target.path, 'utf8');
      atomicWriteTextFile(target.path, spliceBlock(MARKERS, existing, body), { freshMode: 0o644 });
      if (created && target.project) {
        try { ensureGitExcluded(target.path); } catch { /* a project file outside git, or an unwritable exclude, stays as written */ }
      }
    }
    record('installed', created || (prior?.created_file ?? false));
    return out('write', `brain-first block ${before.state === 'stale' ? 'upgraded in' : created ? 'in new file' : 'appended to'} ${target.path}`);
  } catch (e) {
    return out('preserve', `${target.path} could not be updated (${e instanceof Error ? e.message : String(e)}); nothing else was changed`);
  }
}

/** The uninstall path: strip the block, delete the file only when gbrain created it and nothing else is left, forget the record. */
export function removeBrainFirst(opts: { harness: string; path: string; dryRun: boolean }): BrainFirstOutcome {
  const prior = priorBrainFirst(opts.harness, opts.path);
  const before = inspectBrainFirst(opts.path);
  const decision: BrainFirstDecision = { value: 'declined', source: 'flag' };
  const out = (action: BrainFirstOutcome['action'], detail: string): BrainFirstOutcome =>
    ({ harness: opts.harness, path: opts.path, role: 'instruction file', decision, action, state_before: before.state, detail });
  try {
    if (before.state === 'damaged') return out('preserve', `the brain-first markers in ${opts.path} were hand-edited; remove the block by hand`);
    if (before.state === 'no_file' || before.state === 'absent') {
      if (!opts.dryRun) dropLedger(opts.harness, opts.path);
      return out('skip', `no brain-first block in ${opts.path}`);
    }
    if (!opts.dryRun) {
      const stripped = removeBlock(MARKERS, readFileSync(opts.path, 'utf8')).text;
      const deleteFile = (prior?.created_file ?? false) && (stripped.trim() === '' || stripped === CURSOR_HEAD);
      if (deleteFile) unlinkSync(opts.path);
      else atomicWriteTextFile(opts.path, stripped);
      dropLedger(opts.harness, opts.path);
      return out('remove', `brain-first block from ${opts.path}${deleteFile ? ' (file removed: gbrain created it and nothing else was in it)' : ''}`);
    }
    return out('remove', `brain-first block from ${opts.path}`);
  } catch (e) {
    return out('preserve', `${opts.path} could not be updated (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** One human line per outcome, matching setup's step lines. */
export function describeBrainFirstOutcome(o: BrainFirstOutcome, dryRun: boolean): string {
  return `  ${(dryRun && o.action !== 'keep' && o.action !== 'skip' ? `would ${o.action}` : o.action).padEnd(8)} ${'instructions'.padEnd(7)} ${o.detail}`;
}
