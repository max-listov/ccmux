import { existsSync } from "node:fs";
import { loadMachineConfig } from "../config/machine.ts";
import { run } from "../util/spawn.ts";
import { VERSION } from "../util/version.ts";
import { checkFleet } from "../fleet/transport.ts";
import { SELF_DISPLAY, promptInvocation, PLATFORM, HOME } from "../env.ts";

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
  // Verify the fleet map for BOTH outputs. It used to run only on the human path, so the one consumer
  // that cannot eyeball a warning — an agent reading `--json` — was the one kept in the dark about a
  // mis-mapped alias, which is the single failure that silently delivers mail to the wrong machine.
  const fleet = m.fleet ?? {};
  const fleetChecks = Object.keys(fleet).length > 0 ? await checkFleet(fleet) : [];
  // A machine label that equals OUR OWN prefix can never be reached: `routeFor` resolves it locally
  // first (it must — ssh to ourselves lands in a different ccmux). Cloned configs make this easy to
  // do by accident, and the symptom is the original incident: a reply "to the other box" delivered
  // to a local same-named session.
  const selfLabelled = Object.keys(fleet).includes(m.rcPrefix);

  if (json) {
    console.log(
      JSON.stringify({
        version: VERSION,
        generatedAt: new Date().toISOString(),
        os: PLATFORM,
        self: SELF_DISPLAY,
        promptInvocation: promptInvocation(),
        configFile,
        sessionsFile: m.sessionsFile,
        rcPrefix: m.rcPrefix,
        bootLabel: m.bootLabel,
        bins: { claude: m.claudeBin, codex: m.codexBin ?? null, tmux: m.tmuxBin },
        deps: { claude: claudeOk, codex: codexOk, tmux: tmuxOk },
        fleet: fleetChecks,
        fleetSelfLabelled: selfLabelled,
        daemon,
      }),
    );
    return 0;
  }

  console.log(`ccmux ${VERSION}`);
  console.log(`self:       ${SELF_DISPLAY}`);
  console.log(`agent cli:  ${promptInvocation()}`);
  console.log(`config:     ${configFile}`);
  console.log(`sessions:   ${m.sessionsFile}`);
  console.log(`rc prefix:  ${m.rcPrefix}`);
  console.log(`boot label: ${m.bootLabel}`);
  console.log(`claude: ${m.claudeBin} (${claudeOk ? "ok" : "missing"})`);
  console.log(`codex:  ${m.codexBin ?? "—"} (${m.codexBin ? (codexOk ? "ok" : "missing") : "not set"})`);
  console.log(`tmux:   ${m.tmuxBin} (${tmuxOk ? "ok" : "missing"})`);
  if (fleetChecks.length > 0) {
    console.log("fleet:");
    for (const c of fleetChecks) {
      const mark = c.ok ? "ok" : c.reachable ? "PROBLEM" : "unreachable";
      console.log(`  ${c.machine} → ${c.alias} (${mark})${c.ok ? "" : ` — ${c.detail}`}`);
    }
    if (selfLabelled) {
      console.log(`  PROBLEM — '${m.rcPrefix}' is this machine's own rcPrefix, so '${m.rcPrefix}:<session>' always resolves LOCALLY and that entry is dead. Give each machine a distinct rcPrefix.`);
    }
  }
  console.log(`daemon: ${daemon.state}${daemon.manager ? ` (${daemon.manager})` : ""}`);
  return 0;
}
