import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AntigravityProfileBinding } from '../../config/antigravityProfileSchema.ts';
import type { MachineConfig } from '../../types.ts';
import { HOME } from '../../util/home.ts';
import { digestOf } from '../launch/launchInputs.ts';
import { antigravityFileAccountDigest } from './account.ts';
import { antigravityDataDir, antigravityDirFlags } from './preflight.ts';

type AntigravityProfileHost = Pick<MachineConfig, 'antigravityDataDir' | 'antigravityProfiles'>;

const implicit: AntigravityProfileBinding = {
  agent: 'antigravity',
  source: 'default',
  name: 'default',
  dataDir: null,
  storage: 'default',
};

export function antigravityProfileId(binding: AntigravityProfileBinding | undefined): string {
  if (!binding || binding.dataDir === null) return 'default';
  return `ag-${digestOf(binding.dataDir)}`;
}

export function antigravityProfileDataDir(
  m: Pick<MachineConfig, 'antigravityDataDir'>,
  binding?: AntigravityProfileBinding,
  home = HOME,
): string {
  return binding?.dataDir ?? antigravityDataDir(m, home);
}

function machineAntigravityProfiles(
  m: Pick<MachineConfig, 'antigravityProfiles'>,
): AntigravityProfileBinding[] {
  return Object.entries(m.antigravityProfiles ?? {}).map(([name, entry]) => ({
    agent: 'antigravity' as const,
    source: 'machine' as const,
    name,
    dataDir: entry.dataDir,
    storage: 'file' as const,
  }));
}

/** All declared Antigravity profiles on this host (`default` plus `machine.json` entries). */
export function namedAntigravityProfiles(
  m: Pick<MachineConfig, 'antigravityProfiles'>,
): AntigravityProfileBinding[] {
  const profiles = [implicit, ...machineAntigravityProfiles(m)];
  const names = new Set<string>();
  for (const { name } of profiles) {
    if (names.has(name)) throw new Error(`Ambiguous Antigravity profile name: ${name}`);
    names.add(name);
  }
  return profiles;
}

function physicalDirectory(path: string, allowCreate = false): string {
  if (allowCreate && !existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try {
    const dir = realpathSync(path);
    if (statSync(dir).isDirectory()) return dir;
  } catch (error) {
    throw new Error(`Antigravity profile directory unavailable: ${path}`, { cause: error });
  }
  throw new Error(`Antigravity profile path is not a directory: ${path}`);
}

function canonicalDirOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Resolve once at admission or login. A restart uses the pinned directory and account digest. */
export function selectAntigravityProfile(
  m: AntigravityProfileHost,
  name: string,
  opts: { allowMissingDir?: boolean; createDir?: boolean; home?: string } = {},
): AntigravityProfileBinding {
  const declared =
    name === implicit.name ? implicit : namedAntigravityProfiles(m).find((p) => p.name === name);
  if (!declared) throw new Error(`Unknown Antigravity profile: ${name}`);
  const binding: AntigravityProfileBinding =
    declared.source === 'default'
      ? declared
      : opts.allowMissingDir === true && !existsSync(declared.dataDir)
        ? {
            ...declared,
            dataDir: opts.createDir
              ? physicalDirectory(declared.dataDir, true)
              : resolve(declared.dataDir),
          }
        : { ...declared, dataDir: physicalDirectory(declared.dataDir, opts.createDir === true) };
  const dir = antigravityProfileDataDir(m, binding, opts.home);
  const digest = antigravityFileAccountDigest(dir);
  return digest === undefined ? binding : { ...binding, accountDigest: digest };
}

/**
 * Guard against silent retargeting across restarts: a renamed profile keeping the same directory
 * continues safely, while a reassigned name or a swapped Google account inside the profile fails
 * loudly before launching `agy`.
 */
export function verifyAntigravityProfile(
  m: AntigravityProfileHost,
  binding: AntigravityProfileBinding,
  home = HOME,
): void {
  if (binding.source !== 'default') {
    const profiles = machineAntigravityProfiles(m);
    if (profiles.filter((p) => p.name === binding.name).length > 1)
      throw new Error(`Ambiguous Antigravity profile name: ${binding.name}`);
    const original = profiles.find((p) => p.name === binding.name);
    if (original !== undefined) {
      if (original.dataDir === null || physicalDirectory(original.dataDir) !== binding.dataDir)
        throw new Error(`Antigravity profile ${binding.name} now points to a different directory`);
    } else {
      const renamed = profiles.some(
        (p) => p.dataDir !== null && canonicalDirOrResolve(p.dataDir) === binding.dataDir,
      );
      if (!renamed)
        throw new Error(
          `Antigravity profile ${binding.name} is no longer registered at its pinned directory`,
        );
    }
  }
  if (binding.accountDigest !== undefined) {
    const current = antigravityFileAccountDigest(antigravityProfileDataDir(m, binding, home));
    if (current !== binding.accountDigest)
      throw new Error(
        `Antigravity profile ${binding.name} no longer identifies the pinned account`,
      );
  }
}

export interface AntigravityLaunchOptions {
  dataDir: string;
  forceFileStorage: boolean;
  dirFlags: string[];
  extraEnv: Record<string, string>;
  profileId: string;
}

/**
 * Canonical launch parameters shared by ACP session owners, host model probes, quota probes,
 * and interactive `profiles login`. Keeps real `HOME` intact while isolating profile state.
 */
export function antigravityLaunchOptions(
  m: Pick<MachineConfig, 'antigravityDataDir'>,
  binding?: AntigravityProfileBinding,
  home = HOME,
): AntigravityLaunchOptions {
  const dataDir = antigravityProfileDataDir(m, binding, home);
  const forceFileStorage = binding?.storage === 'file';
  return {
    dataDir,
    forceFileStorage,
    dirFlags: antigravityDirFlags(dataDir, home),
    extraEnv: forceFileStorage ? { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1' } : {},
    profileId: antigravityProfileId(binding),
  };
}
