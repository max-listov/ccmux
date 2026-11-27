import { dlopen, FFIType, ptr } from 'bun:ffi';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME, PLATFORM } from '../../util/home.ts';
import { VERSION } from '../../util/version.ts';
import { buildMacosIcns } from './icon.ts';
import {
  MACOS_DEFAULT_BUNDLE_ID,
  MACOS_LAUNCHER_C,
  MACOS_LAUNCHER_NAME,
  macosAppPath,
  macosLauncherPath,
} from './launcherSource.ts';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export interface MacosBundleVerification {
  ok: boolean;
  bundleId: string | null;
  authority: string | null;
  teamId: string | null;
  error: string | null;
}

export interface MacosBundleInstallResult {
  state: 'installed' | 'current';
  appPath: string;
  launcherPath: string;
  bundleId: string;
  authority: string | null;
  teamId: string | null;
}

function runStrict(command: string[], label: string): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${label}: ${err || `exit ${result.exitCode}`}`);
  }
  return result.stdout.toString();
}

/** Extract the first valid Developer ID Application SHA-1 from `security find-identity` output. */
export function findDeveloperId(
  finder: () => string = () =>
    runStrict(['security', 'find-identity', '-v', '-p', 'codesigning'], 'security find-identity'),
): string | null {
  const output = finder();
  const match = output.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application:/m);
  return match?.[1] ?? null;
}

/** Resolve signing identity: explicit option → STITCHMUX_SIGNING_IDENTITY env → Developer ID lookup. */
export function resolveSigningIdentity(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.STITCHMUX_SIGNING_IDENTITY?.trim();
  if (fromEnv) return fromEnv;
  return findDeveloperId();
}

/** Resolve the bundle identifier from explicit option, env override, or public default. */
export function resolveMacosBundleId(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const fromEnv = process.env.STITCHMUX_MACOS_BUNDLE_ID?.trim();
  return fromEnv || MACOS_DEFAULT_BUNDLE_ID;
}

/** Verify an installed `.app` bundle's code signature and extract its signing metadata. */
export function verifyMacosBundle(appPath: string): MacosBundleVerification {
  if (!existsSync(appPath)) {
    return { ok: false, bundleId: null, authority: null, teamId: null, error: 'bundle missing' };
  }
  const verify = Bun.spawnSync(['codesign', '--verify', '--strict', appPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (verify.exitCode !== 0) {
    const err = verify.stderr.toString().trim() || `codesign --verify exit ${verify.exitCode}`;
    return { ok: false, bundleId: null, authority: null, teamId: null, error: err };
  }
  const detail = Bun.spawnSync(['codesign', '-dvv', appPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const text = detail.stderr.toString();
  const bundleId = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const authority = /^Authority=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const teamId = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const isDeveloperId = authority?.startsWith('Developer ID Application:') === true;
  if (!isDeveloperId || !teamId || teamId === 'not set') {
    return {
      ok: false,
      bundleId,
      authority,
      teamId,
      error: `bundle is not signed with Developer ID Application (authority=${authority ?? 'none'}, team=${teamId ?? 'none'})`,
    };
  }
  return { ok: true, bundleId, authority, teamId, error: null };
}

/** Atomically swap two bundles on APFS/HFS+ using Darwin `renameatx_np(RENAME_SWAP)`. */
export function exchangeBundles(staged: string, installed: string): void {
  const libc = dlopen('/usr/lib/libSystem.B.dylib', {
    renameatx_np: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  const next = Buffer.from(`${staged}\0`);
  const current = Buffer.from(`${installed}\0`);
  try {
    // Darwin: AT_FDCWD = -2; RENAME_SWAP = 2.
    if (libc.symbols.renameatx_np(-2, ptr(next), -2, ptr(current), 2) !== 0) {
      throw new Error('Atomic bundle exchange failed; installed bundle was retained');
    }
  } finally {
    libc.close();
  }
}

/** Verify before swap, exchange atomically, verify after swap, and roll back on failure. */
export function installVerifiedBundle(
  staged: string,
  installed: string,
  verify: (path: string) => void = (path) => {
    const check = verifyMacosBundle(path);
    if (!check.ok) throw new Error(`codesign verification failed: ${check.error ?? 'unknown'}`);
  },
  exchange: (stagedPath: string, installedPath: string) => void = exchangeBundles,
): void {
  verify(staged);
  const replacing = existsSync(installed);
  if (replacing) exchange(staged, installed);
  else renameSync(staged, installed);
  try {
    verify(installed);
  } catch (cause) {
    try {
      if (replacing) exchange(staged, installed);
      else renameSync(installed, staged);
    } catch (rollback) {
      throw new AggregateError([cause, rollback], 'Bundle verification and rollback failed', {
        cause,
      });
    }
    throw cause;
  }
  if (replacing) rmSync(staged, { recursive: true, force: true });
}

/** Build and Developer-ID-sign a `stitchmux.app` candidate at `destinationApp` (fail-closed). */
export function buildSignedMacosBundle(
  destinationApp: string,
  options: {
    identity?: string | null;
    bundleId?: string;
    version?: string;
    extraCFlags?: string[];
  } = {},
): void {
  const identity = resolveSigningIdentity(options.identity);
  if (!identity) {
    throw new Error(
      'codesign refused (fail-closed): Developer ID Application identity not found in keychain',
    );
  }
  if (identity === '-') {
    throw new Error(
      'codesign refused (fail-closed): ad-hoc signing is not permitted for stitchmux.app',
    );
  }
  const contents = join(destinationApp, 'Contents');
  const macosDir = join(contents, 'MacOS');
  const resourcesDir = join(contents, 'Resources');
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  const sourcePath = join(destinationApp, '..', `${MACOS_LAUNCHER_NAME}.c`);
  const binaryPath = join(macosDir, MACOS_LAUNCHER_NAME);
  writeFileSync(sourcePath, MACOS_LAUNCHER_C);
  try {
    runStrict(
      [
        'clang',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        ...(options.extraCFlags ?? []),
        sourcePath,
        '-o',
        binaryPath,
      ],
      'clang stitchmux-launcher',
    );
  } finally {
    rmSync(sourcePath, { force: true });
  }

  const version = options.version ?? VERSION;
  const bundleId = resolveMacosBundleId(options.bundleId);
  const infoPlist = {
    CFBundleIdentifier: bundleId,
    CFBundleName: 'stitchmux',
    CFBundleDisplayName: 'stitchmux',
    CFBundleExecutable: MACOS_LAUNCHER_NAME,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleIconFile: 'AppIcon',
    NSHighResolutionCapable: true,
    LSBackgroundOnly: true,
    NSLocalNetworkUsageDescription:
      'stitchmux runs supervised agent sessions and adapters that reach devices on the local network.',
    NSAppleEventsUsageDescription:
      'stitchmux runs supervised agent sessions that automate local macOS applications.',
  };
  const jsonPath = join(contents, 'Info.json');
  writeFileSync(jsonPath, JSON.stringify(infoPlist));
  try {
    runStrict(
      ['plutil', '-convert', 'xml1', jsonPath, '-o', join(contents, 'Info.plist')],
      'plutil',
    );
  } finally {
    rmSync(jsonPath, { force: true });
  }

  buildMacosIcns(resourcesDir);
  runStrict(
    ['codesign', '--force', '--sign', identity, '--timestamp=none', destinationApp],
    'codesign',
  );
  const check = verifyMacosBundle(destinationApp);
  if (!check.ok) {
    throw new Error(`codesign verification failed: ${check.error ?? 'unknown'}`);
  }
}

/** Build in `*.install.noindex`, verify, atomically swap into place, and register with LaunchServices. */
export function installMacosAppBundle(
  options: {
    home?: string;
    appPath?: string;
    identity?: string | null;
    bundleId?: string;
    version?: string;
  } = {},
): MacosBundleInstallResult {
  const home = options.home ?? HOME;
  const installed = options.appPath ?? macosAppPath(home);
  const bundleId = resolveMacosBundleId(options.bundleId);
  mkdirSync(dirname(installed), { recursive: true });
  const stagingRoot = `${installed}.install.noindex`;
  mkdirSync(stagingRoot, { recursive: true });
  const work = mkdtempSync(join(stagingRoot, 'candidate-'));
  const staged = join(work, 'Candidate.app');
  let keepForRecovery = false;
  try {
    buildSignedMacosBundle(staged, {
      ...(options.identity !== undefined ? { identity: options.identity } : {}),
      bundleId,
      ...(options.version !== undefined ? { version: options.version } : {}),
    });
    installVerifiedBundle(staged, installed);
  } catch (error) {
    keepForRecovery = error instanceof AggregateError;
    throw error;
  } finally {
    if (!keepForRecovery) {
      rmSync(work, { recursive: true, force: true });
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  if (existsSync(LSREGISTER)) {
    Bun.spawnSync([LSREGISTER, '-f', installed], { stdout: 'ignore', stderr: 'ignore' });
  }
  const verified = verifyMacosBundle(installed);
  return {
    state: 'installed',
    appPath: installed,
    launcherPath: join(installed, 'Contents', 'MacOS', MACOS_LAUNCHER_NAME),
    bundleId: verified.bundleId ?? bundleId,
    authority: verified.authority,
    teamId: verified.teamId,
  };
}

/** Keep a valid installed `stitchmux.app` untouched unless missing, invalid, or `--force`. */
export function ensureMacosAppBundle(
  options: {
    home?: string;
    appPath?: string;
    identity?: string | null;
    bundleId?: string;
    version?: string;
    force?: boolean;
  } = {},
): MacosBundleInstallResult {
  const home = options.home ?? HOME;
  const installed = options.appPath ?? macosAppPath(home);
  const launcher = join(installed, 'Contents', 'MacOS', MACOS_LAUNCHER_NAME);
  const expectedBundleId = resolveMacosBundleId(options.bundleId);
  if (options.force !== true && existsSync(launcher)) {
    const verified = verifyMacosBundle(installed);
    if (verified.ok && verified.bundleId === expectedBundleId) {
      return {
        state: 'current',
        appPath: installed,
        launcherPath: launcher,
        bundleId: verified.bundleId,
        authority: verified.authority,
        teamId: verified.teamId,
      };
    }
  }
  return installMacosAppBundle(options);
}

/** Query Darwin's responsible PID for `pid` via `responsibility_get_pid_responsible_for_pid`. */
export function responsiblePidOf(pid: number): number | null {
  if (PLATFORM !== 'darwin' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const lib = dlopen('/usr/lib/system/libquarantine.dylib', {
      responsibility_get_pid_responsible_for_pid: {
        args: [FFIType.i32],
        returns: FFIType.i32,
      },
    });
    try {
      const result = lib.symbols.responsibility_get_pid_responsible_for_pid(pid);
      return Number.isInteger(result) && result > 0 ? result : null;
    } finally {
      lib.close();
    }
  } catch {
    return null;
  }
}

export { macosAppPath, macosLauncherPath };
