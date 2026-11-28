import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PermissionMode } from '../../runtime/projectionSchema.ts';
import type { MachineConfig } from '../../types.ts';
import { HOME } from '../../util/home.ts';
import { run } from '../../util/spawn.ts';
import { compareSemver } from '../../util/version.ts';

/** Minimum Antigravity CLI version verified with `agy acp --stdio --process-per-session`. */
export const ANTIGRAVITY_MIN_VERSION = '1.5.14';

/** Minimum Antigravity CLI version supporting `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` for named profiles. */
export const ANTIGRAVITY_MULTIPROFILE_MIN_VERSION = '1.5.18';

export type AntigravityVersionProbe =
  | { ok: true; version: string }
  | { ok: false; reason: 'timeout' | 'exec-failed' | 'unparseable'; detail: string };

interface CachedVersion {
  stamp: string;
  version: string;
}

const versionCache = new Map<string, CachedVersion>();
const inFlightProbes = new Map<string, Promise<AntigravityVersionProbe>>();

/** Where Antigravity CLI keeps its settings, cached auth state and conversation transcripts. */
export function antigravityDataDir(
  m: Pick<MachineConfig, 'antigravityDataDir'>,
  home = HOME,
): string {
  return m.antigravityDataDir ?? join(home, '.gemini', 'antigravity-cli');
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * CLI flags that direct `agy` (both root `agy -p` and `agy acp`) to a specific profile data
 * directory without overriding `HOME`.
 *
 * `agy` requires `--app_data_dir` to be relative to `--gemini_dir` (passing an absolute path to
 * `--app_data_dir` fails at startup). Profiles living directly under `~/.gemini/` only pass
 * `--app_data_dir <leaf>`, inheriting shared `~/.gemini/GEMINI.md` and `~/.gemini/config/` while
 * isolating tokens, transcripts, settings and caches. Custom paths outside `~/.gemini/` pass both
 * `--gemini_dir <parent>` and `--app_data_dir <leaf>`.
 */
export function antigravityDirFlags(dataDir: string, home = HOME): string[] {
  const resolved = resolve(dataDir);
  const parent = dirname(resolved);
  const leaf = basename(resolved);
  const defaultGemini = join(home, '.gemini');
  if (canonicalPath(parent) === canonicalPath(defaultGemini)) {
    return leaf === 'antigravity-cli' ? [] : ['--app_data_dir', leaf];
  }
  return ['--gemini_dir', parent, '--app_data_dir', leaf];
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

export function supportsAntigravityVersion(
  text: string,
  minVersion = ANTIGRAVITY_MIN_VERSION,
): boolean {
  const version = parseAntigravityVersion(text);
  return version !== null && compareSemver(version, minVersion) >= 0;
}

async function probeVersionOnce(
  executable: string,
  timeoutMs: number,
): Promise<AntigravityVersionProbe> {
  try {
    const result = await run([executable, '--version'], { timeoutMs });
    if (result.timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        detail: `agy --version timed out after ${timeoutMs}ms`,
      };
    }
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exited with code ${result.code}`;
      return { ok: false, reason: 'exec-failed', detail: detail.slice(0, 240) };
    }
    const version = parseAntigravityVersion(`${result.stdout}\n${result.stderr}`);
    if (version === null) {
      return {
        ok: false,
        reason: 'unparseable',
        detail: `could not parse version from output: ${result.stdout.trim().slice(0, 120)}`,
      };
    }
    return { ok: true, version };
  } catch (error) {
    return {
      ok: false,
      reason: 'exec-failed',
      detail: error instanceof Error ? error.message : 'failed to spawn agy --version',
    };
  }
}

/**
 * Read and cache the installed binary version asynchronously by file stamp so `runtime.list`
 * never blocks the daemon event loop. Only successful parses are cached: timeouts and transient
 * execution failures are never cached permanently.
 */
export async function readAntigravityVersion(
  executable: string,
  timeoutMs = 5_000,
): Promise<AntigravityVersionProbe> {
  let stamp: string;
  try {
    const stat = statSync(executable);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    return {
      ok: false,
      reason: 'exec-failed',
      detail: error instanceof Error ? error.message : 'binary cannot be stat-ed',
    };
  }
  const cached = versionCache.get(executable);
  if (cached?.stamp === stamp) return { ok: true, version: cached.version };

  const flightKey = `${executable}:${stamp}`;
  const existing = inFlightProbes.get(flightKey);
  if (existing) return existing;

  const task = probeVersionOnce(executable, timeoutMs)
    .then((result) => {
      if (result.ok) versionCache.set(executable, { stamp, version: result.version });
      return result;
    })
    .finally(() => {
      inFlightProbes.delete(flightKey);
    });
  inFlightProbes.set(flightKey, task);
  return task;
}

/**
 * Fail-closed check for cached Antigravity CLI state so preflight never triggers interactive OAuth.
 * A signed-in Antigravity CLI installation stores its state under `antigravityDataDir` (or a
 * dedicated named profile directory with `antigravity-oauth-token`).
 */
export function antigravityAuthPresentAt(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return (
    existsSync(join(dir, 'antigravity-oauth-token')) ||
    existsSync(join(dir, 'jetski_state.pbtxt')) ||
    existsSync(join(dir, 'installation_id')) ||
    existsSync(join(dir, 'settings.json'))
  );
}

export function antigravityAuthPresent(
  m: Pick<MachineConfig, 'antigravityDataDir'>,
  home = HOME,
): boolean {
  return antigravityAuthPresentAt(antigravityDataDir(m, home));
}

export interface AntigravityAvailability {
  availability: 'configured' | 'unavailable';
  reason: string | null;
}

export async function antigravityAvailability(
  m: Pick<MachineConfig, 'antigravityBin' | 'antigravityDataDir'>,
  timeoutMs?: number,
): Promise<AntigravityAvailability> {
  const executable = antigravityBin(m);
  if (!executable) return { availability: 'unavailable', reason: 'runtime-not-configured' };
  const probe = await readAntigravityVersion(executable, timeoutMs);
  if (!probe.ok) return { availability: 'unavailable', reason: 'runtime-version-probe-failed' };
  if (compareSemver(probe.version, ANTIGRAVITY_MIN_VERSION) < 0)
    return { availability: 'unavailable', reason: 'runtime-version-unsupported' };
  if (!antigravityAuthPresent(m))
    return { availability: 'unavailable', reason: 'runtime-auth-unavailable' };
  return { availability: 'configured', reason: null };
}

export interface PreflightAntigravityOptions {
  minVersion?: string;
  dataDir?: string;
  timeoutMs?: number;
  skipAuthCheck?: boolean;
}

/** Host preflight run before any registry or process mutation for a new Antigravity session. */
export async function preflightAntigravity(
  m: Pick<MachineConfig, 'antigravityBin' | 'antigravityDataDir'>,
  flags: readonly string[] = [],
  opts: PreflightAntigravityOptions = {},
): Promise<string> {
  if (flags.length > 0)
    throw new Error('Antigravity native launch accepts typed configuration, not caller flags');
  const executable = antigravityBin(m);
  if (!executable) throw new Error('Antigravity CLI (agy) is not configured on this host');
  const minVersion = opts.minVersion ?? ANTIGRAVITY_MIN_VERSION;
  const probe = await readAntigravityVersion(executable, opts.timeoutMs);
  if (!probe.ok)
    throw new Error(
      `Antigravity CLI version check failed for ${executable} (${probe.reason}): ${probe.detail}`,
    );
  if (compareSemver(probe.version, minVersion) < 0)
    throw new Error(
      `Antigravity runtime requires agy ${minVersion} or newer (found ${probe.version} at ${executable})`,
    );
  if (!opts.skipAuthCheck) {
    const dir = opts.dataDir ?? antigravityDataDir(m);
    if (!antigravityAuthPresentAt(dir))
      throw new Error(`Antigravity CLI has no cached authentication state in ${dir}`);
  }
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
