import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realOs from 'os';

// Bun module mocks are process-wide, so this regression test owns a serial file.
mock.module('os', () => ({
  ...realOs,
  loadavg: () => [0, 0, 0] as [number, number, number],
}));

const { _resetForTest, preflight, shouldProceed } = await import('../src/core/backoff.ts');

const unboundedLoadConfig = {
  loadStopPct: Number.POSITIVE_INFINITY,
  loadSlowPct: Number.POSITIVE_INFINITY,
  memoryStopPct: Number.POSITIVE_INFINITY,
};

describe('backoff when CPU load is unavailable', () => {
  beforeEach(() => _resetForTest());
  afterAll(() => {
    _resetForTest();
    mock.restore();
  });

  test('still enforces the concurrent process limit', async () => {
    expect(await preflight('first', unboundedLoadConfig)).toBe(true);
    expect(await preflight('second', unboundedLoadConfig)).toBe(true);

    const blocked = shouldProceed(unboundedLoadConfig);
    expect(blocked.proceed).toBe(false);
    expect(blocked.reason).toContain('batch processes active');
  });

  test('still enforces the known memory threshold', () => {
    const blocked = shouldProceed({ memoryStopPct: 0 });
    expect(blocked.proceed).toBe(false);
    expect(blocked.reason).toContain('Memory');
  });
});
