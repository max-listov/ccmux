import { antigravityCanProbeUsage, antigravityFileAccount } from '../agent/antigravity/account.ts';
import {
  antigravityLaunchOptions,
  antigravityProfileDataDir,
  namedAntigravityProfiles,
  selectAntigravityProfile,
} from '../agent/antigravity/namedProfiles.ts';
import {
  ANTIGRAVITY_MIN_VERSION,
  ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
  antigravityBin,
  preflightAntigravity,
  readAntigravityVersion,
} from '../agent/antigravity/preflight.ts';
import { namedClaudeProfiles, selectClaudeProfile } from '../agent/claude/namedProfiles.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { profileAuthStatus } from '../quota/probe.ts';
import type { MachineConfig } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { compareSemver } from '../util/version.ts';
import { parseFlags } from './flags.ts';

async function cmdAntigravityProfiles(
  m: MachineConfig,
  action: string | undefined,
  name: string | undefined,
  json: boolean,
): Promise<number> {
  if (action === 'list' && name === undefined) {
    const profiles = namedAntigravityProfiles(m).map((profile) => {
      const dataDir = antigravityProfileDataDir(m, profile);
      return {
        agent: 'antigravity' as const,
        name: profile.name,
        source: profile.source,
        storage: profile.storage,
        dataDir,
        email: antigravityFileAccount(dataDir)?.label ?? null,
      };
    });
    if (json) await printLine(JSON.stringify(profiles));
    else
      for (const line of tableLines(
        ['PROFILE', 'SOURCE', 'STORAGE', 'ACCOUNT', 'DATA DIRECTORY'],
        profiles.map((p) => [
          p.name,
          p.source,
          p.storage,
          p.email ?? (p.storage === 'default' ? '(keychain/probe)' : '(signed out)'),
          p.dataDir,
        ]),
      ))
        console.log(line);
    return 0;
  }

  if (action === 'login' && name !== undefined) {
    const profile = selectAntigravityProfile(m, name, { allowMissingDir: true, createDir: true });
    const launch = antigravityLaunchOptions(m, profile);
    const minVersion = launch.forceFileStorage
      ? ANTIGRAVITY_MULTIPROFILE_MIN_VERSION
      : ANTIGRAVITY_MIN_VERSION;
    const executable = await preflightAntigravity(m, [], {
      minVersion,
      dataDir: launch.dataDir,
      skipAuthCheck: true,
    });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (launch.forceFileStorage) env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = '1';
    else delete env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE;
    const proc = Bun.spawn([executable, 'acp', ...launch.dirFlags, '--login'], {
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await proc.exited;
  }

  if (action !== 'doctor' || name === undefined)
    throw new Error(
      'Use profiles list, profiles doctor --profile NAME, or profiles login --agent antigravity --profile NAME',
    );

  const profile = selectAntigravityProfile(m, name, { allowMissingDir: true });
  const launch = antigravityLaunchOptions(m, profile);
  const minVersion = launch.forceFileStorage
    ? ANTIGRAVITY_MULTIPROFILE_MIN_VERSION
    : ANTIGRAVITY_MIN_VERSION;
  const executable = antigravityBin(m) ?? null;
  let version: string | null = null;
  let error: string | null = null;
  if (executable === null) {
    error = 'Antigravity CLI (agy) is not configured on this host';
  } else {
    const probe = await readAntigravityVersion(executable);
    if (!probe.ok) {
      error = `version check failed for ${executable} (${probe.reason}): ${probe.detail}`;
    } else {
      version = probe.version;
      if (compareSemver(probe.version, minVersion) < 0) {
        error = `requires agy ${minVersion} or newer (found ${probe.version} at ${executable})`;
      }
    }
  }
  const gate = await antigravityCanProbeUsage(launch.dataDir, {
    forceFileStorage: launch.forceFileStorage,
  });
  const loggedIn = gate.ok;
  if (error === null && !gate.ok) error = gate.reason;
  const email = antigravityFileAccount(launch.dataDir)?.label ?? null;
  const ok = error === null && loggedIn;
  if (json) {
    await printLine(
      JSON.stringify({
        agent: 'antigravity',
        name,
        source: profile.source,
        storage: profile.storage,
        dataDir: launch.dataDir,
        executable,
        version,
        minVersion,
        loggedIn,
        email,
        error,
      }),
    );
  } else {
    const who = email ?? (profile.storage === 'default' ? 'keychain/default' : 'signed in');
    console.log(
      `${name}: ${error ?? `signed in (${who}, agy ${version ?? '?'} at ${executable ?? '?'})`}`,
    );
  }
  return ok ? 0 : 1;
}

export async function cmdProfiles(args: string[]): Promise<number> {
  const flags = parseFlags('profiles', args, [1, 1]);
  const agent = flags.str('agent') ?? 'claude';
  const m = loadMachineConfig();
  const action = flags.positionals[0];
  const name = flags.str('profile');
  const json = flags.bool('json');

  if (agent === 'antigravity') {
    return await cmdAntigravityProfiles(m, action, name, json);
  }
  if (agent !== 'claude')
    throw new Error('Named profiles are available for Claude and Antigravity only');

  if (action === 'list' && name === undefined) {
    const profiles = namedClaudeProfiles(m).map(({ name, source, configDir }) => ({
      name,
      source,
      configDir,
    }));
    if (json) await printLine(JSON.stringify(profiles));
    else
      for (const line of tableLines(
        ['PROFILE', 'SOURCE', 'CONFIG DIRECTORY'],
        profiles.map((p) => [p.name, p.source, p.configDir ?? '(implicit)']),
      ))
        console.log(line);
    return 0;
  }
  if (action !== 'doctor' || name === undefined)
    throw new Error('Use profiles list or profiles doctor --profile NAME');
  const profile = selectClaudeProfile(m, 'claude', name);
  const result = await profileAuthStatus(m, profile.configDir);
  const loggedIn = result.ok ? result.status.loggedIn : null;
  const authMethod = result.ok ? (result.status.authMethod ?? null) : null;
  const error = result.ok ? null : result.error;
  if (json)
    await printLine(JSON.stringify({ name, source: profile.source, loggedIn, authMethod, error }));
  else
    console.log(
      `${name}: ${error ?? (loggedIn ? `signed in (${authMethod ?? 'unknown method'})` : 'signed out')}`,
    );
  return loggedIn === true ? 0 : 1;
}
