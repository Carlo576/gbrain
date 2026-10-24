/**
 * #7360: the thin client's OAuth access token, shared across CLI processes.
 *
 * Every `gbrain` command is its own process, so an in-memory cache alone
 * minted one client_credentials token per command, and a per-prompt caller
 * spent the host's /token budget. This file keeps the bearer the host issued
 * until shortly before it expires.
 *
 * Trust: an entry is keyed by a hash of the issuer, MCP URL, client id and
 * client secret, so another client or a rotated secret never reuses it. The
 * file stores the bearer and its expiry only (no secret, no client id) and is
 * written 0600 by an atomic rename, which replaces a planted symlink instead
 * of writing through it. A file another user could read is not trusted. The
 * host authorizes every request against the client's current grant, so a
 * cached token never acts with more scope than the client holds.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { gbrainPath } from './config.ts';

export interface CachedToken {
  access_token: string;
  /** Wall-clock ms after which the token is re-minted (already inside the server's expiry). */
  expires_at_ms: number;
}

interface CacheFile { version: 1; entries: Record<string, CachedToken> }

const cachePath = () => gbrainPath('remote-token-cache.json');

export function tokenCacheKey(remote: { issuer_url: string; mcp_url: string; oauth_client_id: string }, secret: string): string {
  return createHash('sha256').update(JSON.stringify([remote.issuer_url, remote.mcp_url, remote.oauth_client_id, secret])).digest('hex');
}

function readEntries(): Record<string, CachedToken> {
  const path = cachePath();
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      rmSync(path, { force: true });
      return {};
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return {};
    const entries: Record<string, CachedToken> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof value?.access_token === 'string' && Number.isFinite(value.expires_at_ms)) entries[key] = value;
    }
    return entries;
  } catch {
    return {};
  }
}

function writeEntries(entries: Record<string, CachedToken>): void {
  const path = cachePath();
  try {
    mkdirSync(gbrainPath(), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const live = Object.fromEntries(Object.entries(entries).filter(([, e]) => e.expires_at_ms > now));
    if (Object.keys(live).length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: live } satisfies CacheFile), { mode: 0o600, flag: 'wx' });
    try {
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  } catch {
    // A cache that cannot be written only costs a mint on the next process.
  }
}

export function readCachedToken(key: string): CachedToken | undefined {
  const entry = readEntries()[key];
  return entry && entry.expires_at_ms > Date.now() ? entry : undefined;
}

export function writeCachedToken(key: string, token: CachedToken): void {
  writeEntries({ ...readEntries(), [key]: token });
}

export function dropCachedToken(key: string): void {
  const entries = readEntries();
  if (!(key in entries)) return;
  delete entries[key];
  writeEntries(entries);
}

export function clearTokenCacheFile(): void {
  try { rmSync(cachePath(), { force: true }); } catch { /* best-effort */ }
}
