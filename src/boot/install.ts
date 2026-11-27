import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createDefaultLaunchdHostAdapter,
  installAndStartSystemdUnit,
  type LaunchdHostAdapter,
  reloadLaunchdJob,
} from 'stitchkit/service-host';
import { bootArgv } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { HOME, PLATFORM, UID } from '../util/env.ts';
import { log } from '../util/log.ts';
import { run } from '../util/spawn.ts';
import {
  ensureMacosAppBundle,
  macosAppPath,
  macosLauncherPath,
  verifyMacosBundle,
} from './macos/bundle.ts';
import {
  inspectLaunchdJob,
  launchdJobMatchesPlist,
  launchdPlistPath,
  managedTmuxPlistPath,
  readPlistProgramArguments,
  type SpawnRunner,
  tmuxBootLabel,
  tmuxServerPid,
  usesManagedTmuxAgent,
  waitForManagedTmuxReady,
} from './macos/tmuxAgent.ts';
import {
  type BootContext,
  renderLaunchdPlist,
  renderLaunchdTmuxPlist,
  renderSystemdUnit,
  type TmuxBootContext,
} from './render.ts';

const isMac = PLATFORM === 'darwin';

function pathEnv(m: MachineConfig): string {
  const dirs = [
    dirname(process.execPath), // the bun binary's dir (e.g. ~/.bun/bin) — so the daemon's restricted
    // launchd/systemd PATH can still find `bun` for any bare-name spawn. Defense-in-depth alongside
    // spawning bun by absolute path in code; without it, auto-update preflight failed silently.
    dirname(m.claudeBin),
    dirname(m.tmuxBin),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  if (isMac) dirs.unshift('/opt/homebrew/bin');
  return [...new Set(dirs)].join(':');
}

function context(m: MachineConfig, macosLauncher?: string): BootContext {
  return {
    selfArgv: bootArgv(),
    label: m.bootLabel,
    user: UID === 0 ? 'root' : (process.env.USER ?? ''),
    home: HOME,
    configPath: process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`,
    pathEnv: pathEnv(m),
    logDir: isMac ? `${HOME}/Library/Logs` : '/var/log',
    ...(macosLauncher ? { macosLauncher } : {}),
  };
}

function tmuxContext(m: MachineConfig, macosLauncher: string): TmuxBootContext {
  return {
    label: tmuxBootLabel(m),
    tmuxBin: m.tmuxBin,
    ...(m.tmuxSocket ? { tmuxSocket: m.tmuxSocket } : {}),
    home: HOME,
    configPath: process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`,
    pathEnv: pathEnv(m),
    logDir: `${HOME}/Library/Logs`,
    macosLauncher,
  };
}

const systemdUnitPath = (label: string): string => `/etc/systemd/system/${label}`;

/** Enable the job, then replace its plist and verify it under a stable PID. */
export async function applyLaunchAgent(
  label: string,
  plistPath: string,
  content: string,
  expectedProgram: string,
  adapter: LaunchdHostAdapter = createDefaultLaunchdHostAdapter(),
) {
  const result = await adapter.runCommand('/bin/launchctl', ['enable', `gui/${UID}/${label}`]);
  if (result.exitCode !== 0) throw new Error(`Cannot enable ${label}: ${result.stderr}`);
  await reloadLaunchdJob({ label, uid: UID, plistPath, content, expectedProgram, adapter });
}

export async function installBoot(
  m: MachineConfig,
  options: { force?: boolean } = {},
): Promise<void> {
  if (isMac) {
    const app = ensureMacosAppBundle({
      ...(options.force ? { force: true } : {}),
      ...(m.macosBundleId ? { bundleId: m.macosBundleId } : {}),
    });
    console.log(
      `macOS bundle ${app.state}: ${app.appPath} (${app.bundleId}, ${app.authority ?? 'verified'})`,
    );

    const domain = `gui/${UID}`;
    if (usesManagedTmuxAgent(m)) {
      const tmuxLabel = tmuxBootLabel(m);
      const tmuxPlist = managedTmuxPlistPath(m);
      const renderedTmux = renderLaunchdTmuxPlist(tmuxContext(m, app.launcherPath));
      let previousTmux: string | null = null;
      try {
        previousTmux = readFileSync(tmuxPlist, 'utf8');
      } catch {
        previousTmux = null;
      }
      mkdirSync(dirname(tmuxPlist), { recursive: true });
      const tmuxJob = await inspectLaunchdJob(tmuxLabel);
      if (tmuxJob.running) {
        if (previousTmux !== renderedTmux) await atomicWrite(tmuxPlist, renderedTmux);
        if (previousTmux !== null && previousTmux !== renderedTmux) {
          console.log(
            `updated ${tmuxPlist}; existing ${tmuxLabel} left running to preserve live sessions (takes effect on next planned tmux restart or reboot)`,
          );
        } else {
          console.log(`managed tmux LaunchAgent ${tmuxLabel} already running (pid ${tmuxJob.pid})`);
        }
      } else {
        const existingServerPid = await tmuxServerPid(m);
        if (existingServerPid !== null) {
          if (previousTmux !== renderedTmux) await atomicWrite(tmuxPlist, renderedTmux);
          // Do not kill an active unmanaged tmux server holding live sessions.
          await run(['launchctl', 'enable', `${domain}/${tmuxLabel}`]);
          console.log(
            `wrote ${tmuxPlist} and enabled ${tmuxLabel}; existing unmanaged tmux server (pid ${existingServerPid}) left running — it will cut over to ${tmuxLabel} after a planned tmux restart or reboot`,
          );
        } else {
          await applyLaunchAgent(tmuxLabel, tmuxPlist, renderedTmux, app.launcherPath);
          const ready = await waitForManagedTmuxReady(m);
          console.log(
            `wrote ${tmuxPlist} and bootstrapped launchd ${tmuxLabel} (tmux pid ${ready?.pid ?? 'ready'})`,
          );
        }
      }
    }

    const ctx = context(m, app.launcherPath);
    const plist = launchdPlistPath(m.bootLabel);
    mkdirSync(dirname(plist), { recursive: true });
    await applyLaunchAgent(m.bootLabel, plist, renderLaunchdPlist(ctx), app.launcherPath);
    console.log(`wrote ${plist} and bootstrapped launchd ${m.bootLabel}`);
  } else {
    const ctx = context(m);
    const unit = systemdUnitPath(m.bootLabel);
    await installAndStartSystemdUnit({
      scope: 'system',
      unitName: m.bootLabel,
      unitPath: unit,
      content: renderSystemdUnit(ctx),
    });
    console.log(`wrote ${unit} and enabled systemd ${m.bootLabel}`);
  }
}

/**
 * Should the installed boot unit be rewritten? Two rules, and each is a decision someone could
 * reasonably get backwards, so they are named here rather than left inside the I/O.
 *
 * `null` means no unit is installed on this machine — and that is NOT an invitation to write one.
 * Installing is a deliberate act; a daemon that quietly creates a boot unit nobody asked for is
 * worse than one that leaves an uninstalled machine alone.
 *
 * Identical content means nothing to do: no write, no reload, nothing logged. Convergence runs on
 * every daemon start, so the unchanged case is the common one and it must cost nothing.
 */
export function bootUnitNeedsWrite(current: string | null, rendered: string): boolean {
  return current !== null && current !== rendered;
}

function installedMacosLauncher(): string | undefined {
  const launcher = macosLauncherPath(HOME);
  if (!existsSync(launcher)) return undefined;
  return verifyMacosBundle(macosAppPath(HOME)).ok ? launcher : undefined;
}

export async function convergeBootUnit(m: MachineConfig): Promise<boolean> {
  const macosLauncher = isMac ? installedMacosLauncher() : undefined;
  if (isMac && macosLauncher === undefined) {
    log.warn({
      msg: "ccmux.app is not installed or failed codesign verification — run 'ccmux install' to enable signed bundle launch",
      appPath: macosAppPath(HOME),
    });
  }
  const ctx = context(m, macosLauncher);
  const path = isMac ? launchdPlistPath(m.bootLabel) : systemdUnitPath(m.bootLabel);
  const rendered = isMac ? renderLaunchdPlist(ctx) : renderSystemdUnit(ctx);
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  let changed = false;
  if (bootUnitNeedsWrite(current, rendered)) {
    await atomicWrite(path, rendered);
    if (!isMac) await run(['systemctl', 'daemon-reload']);
    log.info({
      msg: isMac
        ? 'boot unit converged to this version (run bootout+bootstrap or ccmux install to reload launchd definition)'
        : 'boot unit converged to this version',
      path,
    });
    changed = true;
  }
  if (isMac && macosLauncher !== undefined && usesManagedTmuxAgent(m)) {
    const tmuxPlist = managedTmuxPlistPath(m);
    const renderedTmux = renderLaunchdTmuxPlist(tmuxContext(m, macosLauncher));
    let currentTmux: string | null = null;
    try {
      currentTmux = readFileSync(tmuxPlist, 'utf8');
    } catch {
      currentTmux = null;
    }
    if (bootUnitNeedsWrite(currentTmux, renderedTmux)) {
      await atomicWrite(tmuxPlist, renderedTmux);
      log.info({
        msg: 'managed tmux LaunchAgent plist converged to this version',
        path: tmuxPlist,
      });
      changed = true;
    }
  }
  return changed;
}

export async function uninstallBoot(m: MachineConfig): Promise<void> {
  if (isMac) {
    await run(['launchctl', 'bootout', `gui/${UID}/${m.bootLabel}`]);
    const plist = launchdPlistPath(m.bootLabel);
    if (existsSync(plist)) unlinkSync(plist);
    if (usesManagedTmuxAgent(m)) {
      const tmuxLabel = tmuxBootLabel(m);
      const tmuxPlist = managedTmuxPlistPath(m);
      if (existsSync(tmuxPlist)) {
        await run(['launchctl', 'bootout', `gui/${UID}/${tmuxLabel}`]);
        unlinkSync(tmuxPlist);
      }
    }
  } else {
    await run(['systemctl', 'disable', '--now', m.bootLabel]);
    const unit = systemdUnitPath(m.bootLabel);
    if (existsSync(unit)) {
      unlinkSync(unit);
      await run(['systemctl', 'daemon-reload']);
    }
  }
  console.log(`uninstalled boot unit ${m.bootLabel}`);
}

/**
 * Bounce the daemon in place — sessions outlive it, so this never drops a conversation.
 *
 * On macOS, if the on-disk plist was migrated (e.g. wrapped with `ccmux.app`) and differs from
 * launchd's loaded job definition, performs `bootout` + `bootstrap` so launchd actually picks up
 * the updated plist (`kickstart -k` alone reuses the cached definition).
 */
export async function restartBoot(
  m: MachineConfig,
  options: { runCmd?: SpawnRunner; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const runCmd = options.runCmd ?? run;
  if (isMac) {
    const domain = `gui/${UID}`;
    const plist = launchdPlistPath(m.bootLabel);
    const [job, plistArgs] = await Promise.all([
      inspectLaunchdJob(m.bootLabel, UID, runCmd),
      readPlistProgramArguments(plist, runCmd),
    ]);
    if (plistArgs !== null && !launchdJobMatchesPlist(job, plistArgs)) {
      const program = plistArgs[0];
      if (!program) throw new Error('Daemon plist has no executable');
      await applyLaunchAgent(m.bootLabel, plist, readFileSync(plist, 'utf8'), program);
      return;
    }
    await runCmd(['launchctl', 'kickstart', '-k', `${domain}/${m.bootLabel}`]);
  } else {
    await runCmd(['systemctl', 'restart', m.bootLabel]);
  }
}
