import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { MachineConfig } from "../types.ts";
import { PLATFORM, UID, HOME, SELF_ARGV } from "../env.ts";
import { renderSystemdUnit, renderLaunchdPlist, type BootContext } from "./render.ts";
import { atomicWrite } from "../util/atomic.ts";
import { run } from "../util/spawn.ts";

const isMac = PLATFORM === "darwin";

function pathEnv(m: MachineConfig): string {
  const dirs = [
    dirname(process.execPath), // the bun binary's dir (e.g. ~/.bun/bin) — so the daemon's restricted
    // launchd/systemd PATH can still find `bun` for any bare-name spawn. Defense-in-depth alongside
    // spawning bun by absolute path in code; without it, auto-update preflight failed silently.
    dirname(m.claudeBin),
    dirname(m.tmuxBin),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  if (isMac) dirs.unshift("/opt/homebrew/bin");
  return [...new Set(dirs)].join(":");
}

function context(m: MachineConfig): BootContext {
  return {
    selfArgv: SELF_ARGV,
    label: m.bootLabel,
    user: UID === 0 ? "root" : (process.env.USER ?? ""),
    home: HOME,
    configPath: process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`,
    pathEnv: pathEnv(m),
    logDir: isMac ? `${HOME}/Library/Logs` : "/var/log",
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
    await run(["launchctl", "bootout", `${domain}/${m.bootLabel}`]); // ignore "not loaded"
    await Bun.sleep(500); // bootout is async — let it fully unload before re-bootstrap (else races to "already loaded")
    await run(["launchctl", "bootstrap", domain, plist]);
    await run(["launchctl", "enable", `${domain}/${m.bootLabel}`]);
    await run(["launchctl", "kickstart", "-k", `${domain}/${m.bootLabel}`]); // guarantee it's actually running
    console.log(`wrote ${plist} and bootstrapped launchd ${m.bootLabel}`);
  } else {
    const unit = systemdUnitPath(m.bootLabel);
    await atomicWrite(unit, renderSystemdUnit(ctx));
    await run(["systemctl", "daemon-reload"]);
    await run(["systemctl", "enable", "--now", m.bootLabel]);
    console.log(`wrote ${unit} and enabled systemd ${m.bootLabel}`);
  }
}

export async function uninstallBoot(m: MachineConfig): Promise<void> {
  if (isMac) {
    await run(["launchctl", "bootout", `gui/${UID}/${m.bootLabel}`]);
    const plist = launchdPlistPath(m.bootLabel);
    if (existsSync(plist)) unlinkSync(plist);
  } else {
    await run(["systemctl", "disable", "--now", m.bootLabel]);
    const unit = systemdUnitPath(m.bootLabel);
    if (existsSync(unit)) {
      unlinkSync(unit);
      await run(["systemctl", "daemon-reload"]);
    }
  }
  console.log(`uninstalled boot unit ${m.bootLabel}`);
}

/** Bounce the daemon in place — sessions outlive it, so this never drops a conversation. */
export async function restartBoot(m: MachineConfig): Promise<void> {
  if (isMac) await run(["launchctl", "kickstart", "-k", `gui/${UID}/${m.bootLabel}`]);
  else await run(["systemctl", "restart", m.bootLabel]);
}
