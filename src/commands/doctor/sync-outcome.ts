/**
 * sync_freshness's verdict for a source with no successful sync recorded
 * (#4960). Freshness and sync outcome are separate: a live first sync is
 * `warn` (running is not fresh), and a source with no lock is `fail` with its
 * last attempt (time, result, holds) and a fix for that state: wait, inspect
 * holds, or retry. Each entry carries its registered code for `details`.
 */
import type { Action } from '../../core/agent-output.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { readLastSyncAttempt, type SyncAttemptState } from '../../core/sync-attempt.ts';
import { doctorVerify } from './check-fix.ts';

export interface SyncOutcomeEntry {
  source_id: string;
  code: 'sync_first_run_in_progress' | 'sync_no_successful_sync';
  reason: 'first_sync_running' | SyncAttemptState;
  last_attempt_at: string | null;
  result: string | null;
  held: number;
  job_id: number | null;
  fix: Action;
}

const DOCS = 'docs/guides/troubleshooting.md#sync-freshness-no-successful-sync';
const VERIFY = doctorVerify('sync_freshness');

/** `next: wait`: re-read the verdict once the running work finishes. */
const waitFix = (why: string): Action =>
  ({ argv: [...VERIFY.argv], consent: [], actor: 'provider', requires_exclusive: false, why, verify: VERIFY, docs: DOCS });

export function firstSyncRunning(sourceId: string, display: string, snap: { holder_pid: number; holder_host: string }): { issue: string; entry: SyncOutcomeEntry } {
  return {
    issue: `Source ${display}: first sync running (pid ${snap.holder_pid} on ${snap.holder_host}), no successful sync yet; wait for it to finish`,
    entry: { source_id: sourceId, code: 'sync_first_run_in_progress', reason: 'first_sync_running', last_attempt_at: null, result: 'running', held: 0, job_id: null,
      fix: waitFix(`The first sync of ${sourceId} holds its live sync lock; it stamps last_sync_at only when it succeeds, so wait and re-run this check rather than starting a second sync.`) },
  };
}

export async function noSuccessfulSync(engine: BrainEngine, sourceId: string, display: string, managed: boolean): Promise<{ issue: string; entry: SyncOutcomeEntry }> {
  const attempt = await readLastSyncAttempt(engine, sourceId, managed);
  const retry: Action = { argv: ['gbrain', 'sync', '--source', sourceId, ...(managed ? ['--no-pull'] : [])], consent: [], actor: 'agent', requires_exclusive: false,
    verify: VERIFY, docs: DOCS, why: `No successful sync of ${sourceId} is recorded; this runs one and stamps last_sync_at when it succeeds.` };
  const inspect: Action = attempt.job_id !== null && !managed
    ? { argv: ['gbrain', 'jobs', 'get', String(attempt.job_id), '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY, docs: DOCS,
      why: `Read-only: sync job #${attempt.job_id}'s status, result and error, before retrying.` }
    : { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY, docs: DOCS,
      why: `Read-only: the held files of ${sourceId}, each with its safe action, and the next step.` };
  const fix = attempt.state === 'attempt_queued'
    ? waitFix(`Sync job #${attempt.job_id} of ${sourceId} is queued or running; wait for it instead of starting another.`)
    : attempt.state === 'holds_pending' ? (attempt.managed_next ?? inspect)
      : attempt.state === 'last_attempt_unsuccessful' ? (attempt.managed_next ?? (attempt.job_id !== null ? { ...inspect, then: retry } : retry))
        : retry;
  const what = attempt.state === 'no_attempt'
    ? `no attempt recorded${attempt.unreadable ? ` (last attempt unreadable: ${attempt.unreadable})` : ''}`
    : `last attempt ${attempt.last_attempt_at ?? 'at an unknown time'}, result ${attempt.result ?? 'unknown'}, ${attempt.held} held`;
  const step = attempt.state === 'attempt_queued' ? 'wait for the queued sync' : attempt.state === 'holds_pending' ? `inspect holds with \`gbrain sync status --source ${sourceId}\``
    : `run \`${retry.argv!.join(' ')}\``;
  return {
    issue: `Source ${display}: no successful sync recorded; ${what}; ${step}`,
    entry: { source_id: sourceId, code: 'sync_no_successful_sync', reason: attempt.state, last_attempt_at: attempt.last_attempt_at, result: attempt.result,
      held: attempt.held, job_id: attempt.job_id, fix },
  };
}
