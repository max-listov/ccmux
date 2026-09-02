import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { bootArgv } from '../config/paths.ts';
import { HOME, PLATFORM, UID } from '../env.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { log } from '../util/log.ts';
import { run } from '../util/spawn.ts';
import { type BootContext, renderLaunchdPlist, renderSystemdUnit } from './render.ts';

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

function context(m: MachineConfig): BootContext {
  return {
    selfArgv: bootArgv(),
    label: m.bootLabel,
    user: UID === 0 ? 'root' : (process.env.USER ?? ''),
    home: HOME,
    configPath: process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`,
    pathEnv: pathEnv(m),
    logDir: isMac ? `${HOME}/Library/Logs` : '/var/log',
  };
}

const systemdUnitPath = (label: string): string => `/etc/systemd/system/${label}`;
const launchdPlistPath = (label: string): string => `${HOME}/Library/LaunchAgents/${label}.plist`;

export async function installBoot(m: MachineConfig): Promise<void> {
  const ctx = context(m);
  if (isMac) {
    const plist = launchdPlistPath(m.bootLabel);
    mkdirSync(dirname(plist), { recursive: true });
    await atomicWrite(plist, renderLaunchdPlist(ctx));
    const domain = `gui/${UID}`;
    await run(['launchctl', 'bootout', `${domain}/${m.bootLabel}`]); // ignore "not loaded"
    await Bun.sleep(500); // bootout is async — let it fully unload before re-bootstrap (else races to "already loaded")
    await run(['launchctl', 'bootstrap', domain, plist]);
    await run(['launchctl', 'enable', `${domain}/${m.bootLabel}`]);
    await run(['launchctl', 'kickstart', '-k', `${domain}/${m.bootLabel}`]); // guarantee it's actually running
    console.log(`wrote ${plist} and bootstrapped launchd ${m.bootLabel}`);
  } else {
    const unit = systemdUnitPath(m.bootLabel);
    await atomicWrite(unit, renderSystemdUnit(ctx));
    await run(['systemctl', 'daemon-reload']);
    await run(['systemctl', 'enable', '--now', m.bootLabel]);
    console.log(`wrote ${unit} and enabled systemd ${m.bootLabel}`);
  }
}

/**
 * Bring the installed boot unit up to the definition this version renders, when the two differ.
 *
 * Without this a change to the boot policy cannot reach a machine at all: the unit is written by
 * `ccmux install` and, once, by the bundle migration — an ordinary release rolls out the code and
 * leaves the unit exactly as it was. So the daemon's restart policy on every already-installed
 * machine is whatever version installed it, and a fix to that policy ships to nobody.
 *
 * Written only when the content differs, so an unchanged machine does no I/O and no reload, and the
 * running daemon is never bounced for it — the next start is what needs the new definition, and
 * bouncing a healthy supervisor to hurry that up trades the problem for a worse one.
 */
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

export async function convergeBootUnit(m: MachineConfig): Promise<boolean> {
  const ctx = context(m);
  const path = isMac ? launchdPlistPath(m.bootLabel) : systemdUnitPath(m.bootLabel);
  const rendered = isMac ? renderLaunchdPlist(ctx) : renderSystemdUnit(ctx);
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (!bootUnitNeedsWrite(current, rendered)) return false;
  await atomicWrite(path, rendered);
  if (!isMac) await run(['systemctl', 'daemon-reload']);
  log.info({ msg: 'boot unit converged to this version', path });
  return true;
}

/** Write the boot unit WITHOUT touching the running daemon. Used by the bundle migration: the
 *  point is that the NEXT start finds a path that exists, and bouncing a healthy supervisor to
 *  achieve that would trade the problem for a worse one. */
export async function writeBootUnitOnly(m: MachineConfig): Promise<void> {
  const ctx = context(m);
  if (isMac) {
    const plist = launchdPlistPath(m.bootLabel);
    mkdirSync(dirname(plist), { recursive: true });
    await atomicWrite(plist, renderLaunchdPlist(ctx));
  } else {
    await atomicWrite(systemdUnitPath(m.bootLabel), renderSystemdUnit(ctx));
    await run(['systemctl', 'daemon-reload']);
  }
}

export async function uninstallBoot(m: MachineConfig): Promise<void> {
  if (isMac) {
    await run(['launchctl', 'bootout', `gui/${UID}/${m.bootLabel}`]);
    const plist = launchdPlistPath(m.bootLabel);
    if (existsSync(plist)) unlinkSync(plist);
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

/** Bounce the daemon in place — sessions outlive it, so this never drops a conversation. */
export async function restartBoot(m: MachineConfig): Promise<void> {
  if (isMac) await run(['launchctl', 'kickstart', '-k', `gui/${UID}/${m.bootLabel}`]);
  else await run(['systemctl', 'restart', m.bootLabel]);
}
