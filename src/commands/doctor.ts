import { existsSync } from "node:fs";
import { loadMachineConfig } from "../config/machine.ts";
import { run } from "../util/spawn.ts";
import { VERSION } from "../util/version.ts";
import { SELF_DISPLAY, PLATFORM, HOME } from "../env.ts";

/** Is the boot daemon registered + running? launchd on macOS, systemd on Linux. */
async function daemonState(os: NodeJS.Platform, bootLabel: string): Promise<{ manager: string | null; state: string }> {
  if (os === "darwin") {
    const { code, stdout } = await run(["launchctl", "list"]);
    if (code !== 0) return { manager: "launchd", state: "unknown" };
    const active = stdout.split("\n").some((l) => l.trim().endsWith(bootLabel));
    return { manager: "launchd", state: active ? "active" : "inactive" };
  }
  if (os === "linux") {
    const { stdout } = await run(["systemctl", "is-active", bootLabel]);
    return { manager: "systemd", state: stdout.trim() || "unknown" };
  }
  return { manager: null, state: "unknown" };
}

export async function cmdDoctor(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const m = loadMachineConfig();
  const configFile = process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`;
  const claudeOk = existsSync(m.claudeBin);
  const codexOk = m.codexBin ? existsSync(m.codexBin) : false;
  const tmuxOk = existsSync(m.tmuxBin);
  const daemon = await daemonState(PLATFORM, m.bootLabel);

  if (json) {
    console.log(
      JSON.stringify({
        version: VERSION,
        generatedAt: new Date().toISOString(),
        os: PLATFORM,
        self: SELF_DISPLAY,
        configFile,
        sessionsFile: m.sessionsFile,
        rcPrefix: m.rcPrefix,
        bootLabel: m.bootLabel,
        bins: { claude: m.claudeBin, codex: m.codexBin ?? null, tmux: m.tmuxBin },
        deps: { claude: claudeOk, codex: codexOk, tmux: tmuxOk },
        daemon,
      }),
    );
    return 0;
  }

  console.log(`ccmux ${VERSION}`);
  console.log(`self:       ${SELF_DISPLAY}`);
  console.log(`config:     ${configFile}`);
  console.log(`sessions:   ${m.sessionsFile}`);
  console.log(`rc prefix:  ${m.rcPrefix}`);
  console.log(`boot label: ${m.bootLabel}`);
  console.log(`claude: ${m.claudeBin} (${claudeOk ? "ok" : "missing"})`);
  console.log(`codex:  ${m.codexBin ?? "—"} (${m.codexBin ? (codexOk ? "ok" : "missing") : "not set"})`);
  console.log(`tmux:   ${m.tmuxBin} (${tmuxOk ? "ok" : "missing"})`);
  console.log(`daemon: ${daemon.state}${daemon.manager ? ` (${daemon.manager})` : ""}`);
  return 0;
}
