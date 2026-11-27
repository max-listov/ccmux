import { existsSync } from 'node:fs';
import type { MachineConfig } from '../../types.ts';
import { HOME, PLATFORM } from '../../util/home.ts';
import { run } from '../../util/spawn.ts';
import { macosAppPath, macosLauncherPath, responsiblePidOf, verifyMacosBundle } from './bundle.ts';
import {
  inspectLaunchdJob,
  managedTmuxPlistPath,
  tmuxBootLabel,
  tmuxServerPid,
  usesManagedTmuxAgent,
} from './tmuxAgent.ts';

export interface MacosRuntimeDoctor {
  appBundle: {
    path: string;
    present: boolean;
    valid: boolean;
    bundleId: string | null;
    authority: string | null;
    error: string | null;
  };
  tmuxAgent: {
    label: string;
    plistPath: string;
    plistPresent: boolean;
    state: 'active' | 'inactive' | 'unknown';
    pid: number | null;
    serverPid: number | null;
    responsiblePid: number | null;
    responsibleMatchesApp: boolean | null;
  } | null;
}

/** Collect macOS signed-bundle and managed tmux LaunchAgent diagnostics; null on non-Darwin hosts. */
export async function macosRuntimeState(m: MachineConfig): Promise<MacosRuntimeDoctor | null> {
  if (PLATFORM !== 'darwin') return null;
  const appPath = macosAppPath(HOME);
  const launcherPath = macosLauncherPath(HOME);
  const present = existsSync(appPath);
  const verified = present
    ? verifyMacosBundle(appPath)
    : { ok: false, bundleId: null, authority: null, teamId: null, error: 'bundle missing' };

  let tmuxAgent: MacosRuntimeDoctor['tmuxAgent'] = null;
  if (usesManagedTmuxAgent(m)) {
    const label = tmuxBootLabel(m);
    const plistPath = managedTmuxPlistPath(m);
    const plistPresent = existsSync(plistPath);
    const job = await inspectLaunchdJob(label);
    const serverPid = existsSync(m.tmuxBin) ? await tmuxServerPid(m) : null;
    const responsiblePid = serverPid !== null ? responsiblePidOf(serverPid) : null;
    let responsibleMatchesApp: boolean | null = null;
    if (responsiblePid !== null) {
      const comm = await run(['ps', '-o', 'comm=', '-p', String(responsiblePid)]);
      responsibleMatchesApp = comm.code === 0 ? comm.stdout.trim() === launcherPath : null;
    }
    tmuxAgent = {
      label,
      plistPath,
      plistPresent,
      state: job.running ? 'active' : 'inactive',
      pid: job.pid,
      serverPid,
      responsiblePid,
      responsibleMatchesApp,
    };
  }

  return {
    appBundle: {
      path: appPath,
      present,
      valid: verified.ok,
      bundleId: verified.bundleId,
      authority: verified.authority,
      error: verified.error,
    },
    tmuxAgent,
  };
}
