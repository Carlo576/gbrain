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

/** Whether the temporary filesystem can store a literal non-UTF-8 byte name. */
export function hasInvalidUtf8TempFs(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-byte-name-probe-'));
  try { writeFileSync(Buffer.concat([Buffer.from(dir + '/caf'), Buffer.from([0xe9])]), 'probe'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EILSEQ') return false; throw error; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
