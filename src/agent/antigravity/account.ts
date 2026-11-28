import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { NativeAccount } from '../../runtime/projectionSchema.ts';
import { PLATFORM } from '../../util/home.ts';
import { run } from '../../util/spawn.ts';
import { antigravityAuthPresentAt } from './preflight.ts';

/**
 * Non-secret account metadata and fail-closed login presence checks for an Antigravity CLI profile.
 *
 * Only `id_token_email` and `auth_method` are parsed from `<dataDir>/antigravity-oauth-token` via
 * a strict allowlist schema. The `token` field's contents are never read, kept, logged, or sent,
 * and macOS Keychain secrets (`-w`/`-g`) are never accessed.
 */

const TokenMetaSchema = z.object({
  id_token_email: z.string().optional(),
  auth_method: z.string().optional(),
});

interface CachedMeta {
  stamp: string;
  email: string | null;
  hasToken: boolean;
}

const cache = new Map<string, CachedMeta>();

export function antigravityTokenFilePath(dataDir: string): string {
  return join(dataDir, 'antigravity-oauth-token');
}

function readTokenFileMeta(dataDir: string): CachedMeta | null {
  const file = antigravityTokenFilePath(dataDir);
  let stamp: string;
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const cached = cache.get(file);
  if (cached !== undefined && cached.stamp === stamp) return cached;
  try {
    const parsedJson = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const meta = TokenMetaSchema.safeParse(parsedJson);
    const emailRaw = meta.data?.id_token_email?.trim() ?? '';
    const email = emailRaw === '' ? null : emailRaw.slice(0, 256);
    const hasToken =
      typeof parsedJson === 'object' &&
      parsedJson !== null &&
      'token' in parsedJson &&
      typeof (parsedJson as { token?: unknown }).token === 'object' &&
      (parsedJson as { token?: unknown }).token !== null &&
      Object.keys((parsedJson as { token: Record<string, unknown> }).token).length > 0;
    const next: CachedMeta = { stamp, email, hasToken };
    cache.set(file, next);
    return next;
  } catch {
    // Keep the previous answer (if any) if the file is mid-write; never include raw JSON in errors.
    return cache.get(file) ?? null;
  }
}

/** Read the profile's signed-in email from its file-backed token metadata, if present. */
export function antigravityFileAccount(dataDir: string): NativeAccount | null {
  const meta = readTokenFileMeta(dataDir);
  if (!meta?.email) return null;
  return {
    label: meta.email,
    organization: null,
    subscription: null,
    provider: 'antigravity',
  };
}

/** Stable SHA-256 digest of the file-backed profile's email for restart identity guards. */
export function antigravityFileAccountDigest(dataDir: string): string | undefined {
  const email = readTokenFileMeta(dataDir)?.email;
  if (!email) return undefined;
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}

/** True when `<dataDir>/antigravity-oauth-token` exists and carries a non-empty `token` entry. */
export function antigravityHasTokenFile(dataDir: string): boolean {
  return readTokenFileMeta(dataDir)?.hasToken === true;
}

/**
 * Metadata-only macOS Keychain existence check (no `-w`, no `-g`).
 * Never reads the secret value and never prompts the user for Keychain access.
 */
async function macOsKeychainHasAntigravityItem(): Promise<boolean> {
  try {
    const res = await run(
      ['/usr/bin/security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity'],
      { timeoutMs: 5_000 },
    );
    return !res.timedOut && res.code === 0;
  } catch {
    return false;
  }
}

export interface AntigravityProbeGateOptions {
  /** Named profiles always force file-backed storage and must never fall back to OS Keychain. */
  forceFileStorage: boolean;
  platform?: NodeJS.Platform;
  keychainProbe?: () => Promise<boolean>;
}

/**
 * Fail-closed gate before invoking `agy -p "/usage"`.
 * Running `agy -p "/usage"` on an unauthenticated profile starts interactive OAuth and opens the
 * user's browser; this gate guarantees we refuse before spawning `agy` whenever no login exists.
 */
export async function antigravityCanProbeUsage(
  dataDir: string,
  opts: AntigravityProbeGateOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.forceFileStorage) {
    if (antigravityHasTokenFile(dataDir)) return { ok: true };
    return {
      ok: false,
      reason: 'the Antigravity profile is not signed in (no antigravity-oauth-token)',
    };
  }
  if (antigravityHasTokenFile(dataDir)) return { ok: true };
  const platform = opts.platform ?? PLATFORM;
  if (platform === 'darwin') {
    if (!antigravityAuthPresentAt(dataDir)) {
      return { ok: false, reason: 'Antigravity has no cached state on this host' };
    }
    const check = opts.keychainProbe ?? macOsKeychainHasAntigravityItem;
    if (await check()) return { ok: true };
    return { ok: false, reason: 'Antigravity default profile is not signed in' };
  }
  return {
    ok: false,
    reason: 'the Antigravity profile is not signed in (no antigravity-oauth-token)',
  };
}
