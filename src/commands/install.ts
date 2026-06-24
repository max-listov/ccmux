import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOME, PLATFORM } from "../env.ts";
import { loadMachineConfig, scaffoldMachineConfig } from "../config/machine.ts";
import { RC_PREFIX_RE } from "../config/schema.ts";
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

function isRcPrefix(v: string | undefined): v is string {
  return v !== undefined && RC_PREFIX_RE.test(v);
}

export async function cmdInstall(args: string[]): Promise<number> {
  const cfg = configPath();
  const rc = parseRcPrefix(args);
  const releaseUrl = parseReleaseUrl(args);
  try {
    if (!existsSync(cfg)) {
      if (!isRcPrefix(rc)) {
        console.log("no machine.json yet — run: ccmux install --rc-prefix <name> (lowercase slug, e.g. local, dev, prod)");
        return 1;
      }
      const scaffolded = scaffoldMachineConfig(rc);
      // --release-url wires self-update on first install: point at a release.json + turn
      // autoUpdate on, so a client tracks the published fleet version from the start.
      const withUpdate = releaseUrl ? { ...scaffolded, releaseUrl, autoUpdate: true } : scaffolded;
      mkdirSync(dirname(cfg), { recursive: true });
      await atomicWrite(cfg, JSON.stringify(withUpdate, null, 2) + "\n");
      console.log(`wrote ${cfg} (rcPrefix=${rc}${releaseUrl ? `, autoUpdate→${releaseUrl}` : ""})`);
    } else if (isRcPrefix(rc) || releaseUrl !== undefined) {
      // Re-install over an EXISTING config: apply the passed flags (the rest is preserved), so
      // `install --release-url …` actually rewires self-update instead of being silently ignored.
      const updated = {
        ...loadMachineConfig(),
        ...(isRcPrefix(rc) ? { rcPrefix: rc } : {}),
        ...(releaseUrl !== undefined ? { releaseUrl, autoUpdate: true } : {}),
      };
      await atomicWrite(cfg, JSON.stringify(updated, null, 2) + "\n");
      console.log(`updated ${cfg}${isRcPrefix(rc) ? ` (rcPrefix=${rc})` : ""}${releaseUrl !== undefined ? `, autoUpdate→${releaseUrl}` : ""}`);
    }
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    return 1;
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
