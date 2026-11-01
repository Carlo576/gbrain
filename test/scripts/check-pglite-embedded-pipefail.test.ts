import { test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'check-pglite-embedded.sh');

test('compiled PGLite error markers still fail when output is large', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'gbrain-pglite-pipefail-'));
  const fakeBin = join(fixture, 'bin');
  mkdirSync(fakeBin);
  const bun = join(fakeBin, 'bun');
  writeFileSync(bun, `#!/usr/bin/env bash
set -eu
if [[ "$1" == build ]]; then
  out=''
  while (($#)); do
    if [[ "$1" == --outfile ]]; then out="$2"; shift 2; else shift; fi
  done
  cat > "$out" <<'SMOKE'
#!/usr/bin/env bash
printf 'PGLite failed to initialize\\n'
head -c 131072 /dev/zero | tr '\\0' x
printf '\\n{"pageFound":true,"ok":true}\\n'
SMOKE
  chmod +x "$out"
fi
`);
  chmodSync(bun, 0o755);

  try {
    let result: { status: number | null; stdout: string; stderr: string };
    try {
      const stdout = execFileSync('bash', [SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      result = { status: 0, stdout, stderr: '' };
    } catch (error) {
      const child = error as { status: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
      result = {
        status: child.status,
        stdout: String(child.stdout ?? ''),
        stderr: String(child.stderr ?? ''),
      };
    }

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL: compiled binary hit a Bun-vfs asset error');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('reports the exit status when the compiled binary is killed before producing output', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'gbrain-pglite-exit-status-'));
  const fakeBin = join(fixture, 'bin');
  mkdirSync(fakeBin);
  const bun = join(fakeBin, 'bun');
  writeFileSync(bun, `#!/usr/bin/env bash
set -eu
if [[ "$1" == build ]]; then
  out=''
  while (($#)); do
    if [[ "$1" == --outfile ]]; then out="$2"; shift 2; else shift; fi
  done
  cat > "$out" <<'SMOKE'
#!/usr/bin/env bash
exit 137
SMOKE
  chmod +x "$out"
fi
`);
  chmodSync(bun, 0o755);

  try {
    let result: { status: number | null; stdout: string; stderr: string };
    try {
      const stdout = execFileSync('bash', [SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      result = { status: 0, stdout, stderr: '' };
    } catch (error) {
      const child = error as { status: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
      result = {
        status: child.status,
        stdout: String(child.stdout ?? ''),
        stderr: String(child.stderr ?? ''),
      };
    }

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('compiled binary exited with status 137');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
