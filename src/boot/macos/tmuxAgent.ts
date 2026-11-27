import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmuxArgv } from '../../tmux/argv.ts';
import type { MachineConfig } from '../../types.ts';
import { HOME, PLATFORM, UID } from '../../util/env.ts';
import { type RunResult, run } from '../../util/spawn.ts';

export type SpawnRunner = (argv: string[], opts?: { signal?: AbortSignal }) => Promise<RunResult>;

export interface LaunchdJobInfo {
  loaded: boolean;
  running: boolean;
  pid: number | null;
  program: string | null;
  arguments: string[];
}

export interface ManagedTmuxReadyResult {
  pid: number;
  waitedMs: number;
}

/** Label of the dedicated macOS LaunchAgent that hosts the managed tmux server. */
export function tmuxBootLabel(m: Pick<MachineConfig, 'bootLabel' | 'tmuxBootLabel'>): string {
  if (m.tmuxBootLabel) return m.tmuxBootLabel;
  if (m.bootLabel.endsWith('.daemon')) return `${m.bootLabel.slice(0, -'.daemon'.length)}.tmux`;
  return `${m.bootLabel}.tmux`;
}

/**
 * Whether this instance uses a dedicated macOS LaunchAgent for its tmux server.
 *
 * Dev/isolated instances that set a custom `tmuxSocket` without an explicit `tmuxBootLabel`
 * never touch the production `com.ccmux.tmux` LaunchAgent. Linux uses systemd and never uses one.
 */
export function usesManagedTmuxAgent(
  m: Pick<MachineConfig, 'tmuxSocket' | 'tmuxBootLabel'>,
  platform: NodeJS.Platform = PLATFORM,
): boolean {
  if (platform !== 'darwin') return false;
  if (m.tmuxBootLabel !== undefined) return true;
  return m.tmuxSocket === undefined;
}

export function launchdPlistPath(label: string, home: string = HOME): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function managedTmuxPlistPath(
  m: Pick<MachineConfig, 'bootLabel' | 'tmuxBootLabel'>,
  home: string = HOME,
): string {
  return launchdPlistPath(tmuxBootLabel(m), home);
}

/** True when this macOS instance has a managed tmux LaunchAgent plist installed on disk. */
export function hasManagedTmuxUnit(
  m: Pick<MachineConfig, 'bootLabel' | 'tmuxBootLabel' | 'tmuxSocket'>,
  home: string = HOME,
  platform: NodeJS.Platform = PLATFORM,
): boolean {
  return usesManagedTmuxAgent(m, platform) && existsSync(managedTmuxPlistPath(m, home));
}

/** Read the PID of the currently running tmux server on `m`'s socket without starting one. */
export async function tmuxServerPid(
  m: MachineConfig,
  runCmd: SpawnRunner = run,
  signal?: AbortSignal,
): Promise<number | null> {
  const result = await runCmd(
    tmuxArgv(m, 'display-message', '-p', '#{pid}'),
    signal ? { signal } : undefined,
  );
  if (result.code !== 0) return null;
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Wait until the managed macOS `com.ccmux.tmux` server has bound its socket before any
 * `new-session` runs. Prevents the login startup race where `com.ccmux.daemon` spawns an
 * unmanaged rogue tmux server while `com.ccmux.tmux` is still starting.
 *
 * Returns `null` immediately when no managed tmux LaunchAgent applies (Linux, dev instances with
 * their own `tmuxSocket`, or machines without a managed tmux plist). Throws fail-closed on timeout.
 */
export async function waitForManagedTmuxReady(
  m: MachineConfig,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    checkPid?: () => Promise<number | null>;
    sleep?: (ms: number) => Promise<void>;
    home?: string;
    platform?: NodeJS.Platform;
    forceCheck?: boolean;
  } = {},
): Promise<ManagedTmuxReadyResult | null> {
  const home = options.home ?? HOME;
  const platform = options.platform ?? PLATFORM;
  if (options.forceCheck !== true && !hasManagedTmuxUnit(m, home, platform)) return null;

  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;
  const checkPid = options.checkPid ?? (() => tmuxServerPid(m, run, options.signal));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (true) {
    options.signal?.throwIfAborted();
    const pid = await checkPid();
    if (pid !== null) {
      return { pid, waitedMs: Date.now() - startedAt };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `managed tmux LaunchAgent '${tmuxBootLabel(m)}' did not become ready within ${timeoutMs} ms — refusing to spawn an unmanaged tmux server`,
      );
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

/** Parse `launchctl print gui/<uid>/<label>` output into structured job state. */
export function parseLaunchctlPrint(stdout: string): LaunchdJobInfo {
  const pidMatch = /^\s*pid = (\d+)$/m.exec(stdout);
  const pid = pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : null;
  const program = /^\s*program = (.+)$/m.exec(stdout)?.[1]?.trim() ?? null;
  const state = /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? '';
  const argsBlock = /^\s*arguments = \{\n([\s\S]*?)\n\s*\}/m.exec(stdout)?.[1] ?? '';
  const args = argsBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    loaded: true,
    running: state === 'running' || (pid !== null && pid > 0),
    pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
    program,
    arguments: args,
  };
}

/** Query launchd state for `label` in the user GUI domain. */
export async function inspectLaunchdJob(
  label: string,
  uid: number = UID,
  runCmd: SpawnRunner = run,
): Promise<LaunchdJobInfo> {
  const printed = await runCmd(['launchctl', 'print', `gui/${uid}/${label}`]);
  if (printed.code !== 0) {
    return { loaded: false, running: false, pid: null, program: null, arguments: [] };
  }
  return parseLaunchctlPrint(printed.stdout);
}

/** Read `ProgramArguments` from a launchd XML/binary plist via `plutil`. */
export async function readPlistProgramArguments(
  plistPath: string,
  runCmd: SpawnRunner = run,
): Promise<string[] | null> {
  if (!existsSync(plistPath)) return null;
  const extracted = await runCmd([
    'plutil',
    '-extract',
    'ProgramArguments',
    'json',
    '-o',
    '-',
    plistPath,
  ]);
  if (extracted.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(extracted.stdout);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Whether launchd's currently loaded job matches the on-disk plist's ProgramArguments. */
export function launchdJobMatchesPlist(
  job: LaunchdJobInfo,
  plistArgs: readonly string[] | null,
): boolean {
  if (!job.loaded || plistArgs === null || plistArgs.length === 0) return false;
  if (job.program !== plistArgs[0]) return false;
  if (job.arguments.length > 0) {
    if (job.arguments.length !== plistArgs.length) return false;
    return job.arguments.every((arg, index) => arg === plistArgs[index]);
  }
  return true;
}
