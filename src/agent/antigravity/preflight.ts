import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from '../../runtime/projectionSchema.ts';
import type { MachineConfig } from '../../types.ts';
import { HOME } from '../../util/home.ts';
import { compareSemver } from '../../util/version.ts';

/** Minimum Antigravity CLI version verified with `agy acp --stdio --process-per-session`. */
export const ANTIGRAVITY_MIN_VERSION = '1.5.14';

interface CachedVersion {
  stamp: string;
  version: string | null;
}

const versionCache = new Map<string, CachedVersion>();

/** Where Antigravity CLI keeps its settings, cached auth state and conversation transcripts. */
export function antigravityDataDir(
  m: Pick<MachineConfig, 'antigravityDataDir'>,
  home = HOME,
): string {
  return m.antigravityDataDir ?? join(home, '.gemini', 'antigravity-cli');
}

/** Resolve the configured `agy` binary path, if present on disk. */
export function antigravityBin(m: Pick<MachineConfig, 'antigravityBin'>): string | undefined {
  if (m.antigravityBin && existsSync(m.antigravityBin)) return m.antigravityBin;
  return undefined;
}

/**
 * Parse a semantic version from `agy --version` output (e.g. `1.5.14` or `antigravity 1.5.14`).
 */
export function parseAntigravityVersion(text: string): string | null {
  const match = text.trim().match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export function supportsAntigravityVersion(text: string): boolean {
  const version = parseAntigravityVersion(text);
  return version !== null && compareSemver(version, ANTIGRAVITY_MIN_VERSION) >= 0;
}

/** Read and cache the installed binary version by file stamp so `runtime.list` stays cheap. */
export function readAntigravityVersion(executable: string): string | null {
  let stamp: string;
  try {
    const stat = statSync(executable);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const cached = versionCache.get(executable);
  if (cached?.stamp === stamp) return cached.version;
  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  const version = result.exitCode === 0 ? parseAntigravityVersion(output) : null;
  versionCache.set(executable, { stamp, version });
  return version;
}

/**
 * Fail-closed check for cached Antigravity CLI state so preflight never triggers interactive OAuth.
 * A signed-in Antigravity CLI installation stores its state under `antigravityDataDir`.
 */
export function antigravityAuthPresent(
  m: Pick<MachineConfig, 'antigravityDataDir'>,
  home = HOME,
): boolean {
  const dir = antigravityDataDir(m, home);
  if (!existsSync(dir)) return false;
  return (
    existsSync(join(dir, 'jetski_state.pbtxt')) ||
    existsSync(join(dir, 'installation_id')) ||
    existsSync(join(dir, 'settings.json'))
  );
}

export interface AntigravityAvailability {
  availability: 'configured' | 'unavailable';
  reason: string | null;
}

export function antigravityAvailability(
  m: Pick<MachineConfig, 'antigravityBin' | 'antigravityDataDir'>,
): AntigravityAvailability {
  const executable = antigravityBin(m);
  if (!executable) return { availability: 'unavailable', reason: 'runtime-not-configured' };
  const version = readAntigravityVersion(executable);
  if (version === null || compareSemver(version, ANTIGRAVITY_MIN_VERSION) < 0)
    return { availability: 'unavailable', reason: 'runtime-version-unsupported' };
  if (!antigravityAuthPresent(m))
    return { availability: 'unavailable', reason: 'runtime-auth-unavailable' };
  return { availability: 'configured', reason: null };
}

/** Host preflight run before any registry or process mutation for a new Antigravity session. */
export function preflightAntigravity(
  m: Pick<MachineConfig, 'antigravityBin' | 'antigravityDataDir'>,
  flags: readonly string[] = [],
): string {
  if (flags.length > 0)
    throw new Error('Antigravity native launch accepts typed configuration, not caller flags');
  const executable = antigravityBin(m);
  if (!executable) throw new Error('Antigravity CLI (agy) is not configured on this host');
  const version = readAntigravityVersion(executable);
  if (version === null || compareSemver(version, ANTIGRAVITY_MIN_VERSION) < 0)
    throw new Error(`Antigravity runtime requires agy ${ANTIGRAVITY_MIN_VERSION} or newer`);
  if (!antigravityAuthPresent(m))
    throw new Error('Antigravity CLI has no cached authentication state on this host');
  return executable;
}

/** Map Stitchmux's unified permission modes onto Antigravity ACP `mode` config values. */
export function toAcpMode(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'default';
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'accept-edits';
    case 'bypassPermissions':
      return 'auto';
  }
}

/** Map an Antigravity ACP `mode` config value back to Stitchmux's unified permission mode. */
export function fromAcpMode(value: string | undefined): PermissionMode {
  switch (value) {
    case 'plan':
      return 'plan';
    case 'accept-edits':
      return 'acceptEdits';
    case 'auto':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}
