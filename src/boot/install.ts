import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createDefaultLaunchdHostAdapter,
  installAndStartSystemdUnit,
  type LaunchdHostAdapter,
  reloadLaunchdJob,
} from 'stitchkit/service-host';
import { PREVIOUS_BOOT_UNITS } from '../migration/renameFromCcmux.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { bootArgv } from '../util/env.ts';
import { HOME, PLATFORM, UID } from '../util/home.ts';
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
    configPath: process.env.STITCHMUX_CONFIG ?? `${HOME}/.config/stitchmux/machine.json`,
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
    configPath: process.env.STITCHMUX_CONFIG ?? `${HOME}/.config/stitchmux/machine.json`,
    pathEnv: pathEnv(m),
    logDir: `${HOME}/Library/Logs`,
    macosLauncher,
  };
}

export const systemdUnitPath = (label: string): string => `/etc/systemd/system/${label}`;

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

/**
 * Rename window: retire the boot units the previous release installed before this one installs its
 * own, so two daemons never manage the same sessions. The old daemon unit is stopped and removed —
 * its tmux server and sessions survive (`KillMode=process` on Linux; on macOS the daemon is not their
 * parent). The old tmux LaunchAgent is NOT booted out: that would end the live server and every
 * session on it. Only its plist goes, so the next login starts the new agent alone. REMOVE with
 * `src/migration/renameFromCcmux.ts`.
 */
export async function retirePreviousBootUnits(
  m: MachineConfig,
  deps: {
    readonly mac: boolean;
    readonly run: (argv: string[]) => Promise<unknown>;
    readonly exists: (path: string) => boolean;
    readonly unlink: (path: string) => void;
    /** Copy a directory and what is in it, keeping a target that already exists. */
    readonly copyDir: (from: string, to: string) => void;
    readonly plistPath: (label: string) => string;
    readonly unitPath: (unit: string) => string;
  } = {
    mac: isMac,
    run,
    exists: existsSync,
    unlink: unlinkSync,
    copyDir: (from, to) => cpSync(from, to, { recursive: true, force: false }),
    plistPath: launchdPlistPath,
    unitPath: systemdUnitPath,
  },
): Promise<string[]> {
  const retired: string[] = [];
  if (deps.mac) {
    const daemon = PREVIOUS_BOOT_UNITS.launchdDaemon;
    const daemonPlist = deps.plistPath(daemon);
    if (m.bootLabel !== daemon && deps.exists(daemonPlist)) {
      await deps.run(['launchctl', 'bootout', `gui/${UID}/${daemon}`]);
      deps.unlink(daemonPlist);
      retired.push(daemon);
    }
    const tmux = PREVIOUS_BOOT_UNITS.launchdTmux;
    const tmuxPlist = deps.plistPath(tmux);
    if (tmuxBootLabel(m) !== tmux && deps.exists(tmuxPlist)) {
      deps.unlink(tmuxPlist);
      retired.push(`${tmux} (plist only; the running server is kept)`);
    }
  } else {
    const daemon = PREVIOUS_BOOT_UNITS.systemdDaemon;
    const unit = deps.unitPath(daemon);
    if (m.bootLabel !== daemon && deps.exists(unit)) {
      // The machine's own settings for the daemon — a fleet resource slice, memory ceiling or OOM
      // score — live in the unit's drop-in directory. They belong to the daemon, not to its name.
      const dropIns = `${unit}.d`;
      const next = `${deps.unitPath(m.bootLabel)}.d`;
      if (deps.exists(dropIns) && !deps.exists(next)) deps.copyDir(dropIns, next);
      await deps.run(['systemctl', 'disable', '--now', daemon]);
      deps.unlink(unit);
      await deps.run(['systemctl', 'daemon-reload']);
      retired.push(daemon);
    }
  }
  for (const unit of retired) console.log(`retired the previous release's boot unit ${unit}`);
  return retired;
}

export async function installBoot(
  m: MachineConfig,
  options: { force?: boolean } = {},
): Promise<void> {
  await retirePreviousBootUnits(m);
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
      msg: "stitchmux.app is not installed or failed codesign verification — run 'stitchmux install' to enable signed bundle launch",
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
        ? 'boot unit converged to this version (run bootout+bootstrap or stitchmux install to reload launchd definition)'
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
 * On macOS, if the on-disk plist was migrated (e.g. wrapped with `stitchmux.app`) and differs from
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
