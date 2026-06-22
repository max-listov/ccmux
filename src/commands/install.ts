import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOME, PLATFORM } from "../env.ts";
import { loadMachineConfig, scaffoldMachineConfig } from "../config/machine.ts";
import { installBoot, uninstallBoot } from "../boot/install.ts";
import { atomicWrite } from "../util/atomic.ts";

function configPath(): string {
  return process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`;
}

function parseRcPrefix(args: string[]): string | undefined {
  const i = args.indexOf("--rc-prefix");
  if (i !== -1) return args[i + 1];
  return args.find((a) => !a.startsWith("-"));
}

function parseReleaseUrl(args: string[]): string | undefined {
  const i = args.indexOf("--release-url");
  return i !== -1 ? args[i + 1] : undefined;
}

function isRcPrefix(v: string | undefined): v is "local" | "dev" | "prod" {
  return v === "local" || v === "dev" || v === "prod";
}

export async function cmdInstall(args: string[]): Promise<number> {
  const cfg = configPath();
  if (!existsSync(cfg)) {
    const rc = parseRcPrefix(args);
    if (!isRcPrefix(rc)) {
      console.log("no machine.json yet — run: ccmux install --rc-prefix <local|dev|prod>");
      return 1;
    }
    try {
      const scaffolded = scaffoldMachineConfig(rc);
      // --release-url wires self-update on first install: point at a release.json + turn
      // autoUpdate on, so a client tracks the published fleet version from the start.
      const releaseUrl = parseReleaseUrl(args);
      const withUpdate = releaseUrl ? { ...scaffolded, releaseUrl, autoUpdate: true } : scaffolded;
      mkdirSync(dirname(cfg), { recursive: true });
      await atomicWrite(cfg, JSON.stringify(withUpdate, null, 2) + "\n");
      console.log(`wrote ${cfg} (rcPrefix=${rc}${releaseUrl ? `, autoUpdate→${releaseUrl}` : ""})`);
    } catch (e) {
      console.log(e instanceof Error ? e.message : String(e));
      return 1;
    }
  }
  const m = loadMachineConfig();
  console.log(`detected: claude=${m.claudeBin} tmux=${m.tmuxBin} projects=${m.projectsDir}`);
  await installBoot(m);
  console.log(`install complete (${PLATFORM === "darwin" ? "launchd" : "systemd"}). daemon running.`);
  return 0;
}

export async function cmdUninstall(): Promise<number> {
  const m = loadMachineConfig();
  await uninstallBoot(m);
  console.log("uninstalled. sessions file + jsonl history kept on disk.");
  return 0;
}
