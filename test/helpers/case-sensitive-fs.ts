import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whether the temporary filesystem can represent two case-only names. */
export function hasCaseSensitiveTempFs(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-case-probe-'));
  try {
    writeFileSync(join(dir, 'Case'), 'probe');
    return !existsSync(join(dir, 'case'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
