/**
 * Fail-open BudgetTracker recording for gateway spend sites. No tracker is a
 * no-op; a BudgetExhausted from `record()` (TX1) is swallowed — the breach
 * surfaces on the NEXT `reserve()`, and the call's own result or error wins.
 */

import { readProviderFailureSignals } from './errors.ts';
import {
  usageFromError,
  type BudgetActualUsage,
  type BudgetKind,
  type BudgetTracker,
} from '../budget/budget-tracker.ts';

export function recordOnTracker(tracker: BudgetTracker | null, actual: BudgetActualUsage & { kind?: BudgetKind }): void {
  if (!tracker) return;
  try {
    tracker.record(actual);
  } catch {
    // BudgetExhausted (TX1) — surfaced via the next reserve().
  }
}

/**
 * Usage fields for a failed call: what the SDK error reports, else the
 * pessimistic fallback (A3 amended) flagged `estimated`. `rejected`: the
 * provider refused it with an HTTP error status (a 4xx other than 408 Request
 * Timeout, or a 5xx) and reported no usage, so it billed nothing.
 */
export function failedCallUsage(
  err: unknown,
  fallback: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number; failed: true; estimated: boolean; rejected: boolean } {
  const found = usageFromError(err);
  const { status } = readProviderFailureSignals(err);
  return {
    inputTokens: found?.inputTokens ?? fallback.inputTokens,
    outputTokens: found?.outputTokens ?? fallback.outputTokens,
    failed: true,
    estimated: found?.inputTokens == null || found?.outputTokens == null,
    rejected: found === null && status !== undefined && status >= 400 && status < 600 && status !== 408,
  };
}
