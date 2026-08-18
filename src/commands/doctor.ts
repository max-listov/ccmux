import { existsSync } from "node:fs";
import { loadMachineConfig } from "../config/machine.ts";
import { run } from "../util/spawn.ts";
import { APP_BUNDLE, CACHE_DIR, DATA_DIR, chatAuthPath } from "../config/paths.ts";
import { loadSessions } from "../config/sessions.ts";
import { collectRows } from "./list.ts";
import type { MachineConfig } from "../types.ts";
import { VERSION } from "../util/version.ts";
import { checkFleet, peersOf } from "../fleet/transport.ts";
import { wireSocketPath } from "../fleet/wire.ts";
import { SELF_DISPLAY, promptInvocation, PLATFORM, HOME, UID } from "../env.ts";
import { escalationRefusal } from "../agent/claude/launch.ts";
import { chatEnabledFor } from "../config/chat.ts";

/** Sessions currently stranded at a blocking menu. Read through the same row builder `list` uses,
 *  so the two can never disagree about who is waiting. */
async function sessionsAtPrompt(m: MachineConfig): Promise<{ name: string; question: string }[]> {
  const rows = await collectRows(m);
  return rows
    .filter((r) => r.atPrompt !== null)
    .map((r) => ({ name: r.session.name, question: r.atPrompt as string }));
}

/** Whether the file the boot unit and the PATH shim launch is actually on disk. Checked because a
 *  version number proves nothing here: the process holding this code was loaded from a path that may
 *  no longer exist, and it will keep answering until the day it is asked to start again. */
function bundlePresent(): boolean {
  return existsSync(APP_BUNDLE);
}

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
  const peers = peersOf(m);
  const fleetChecks = peers.length > 0 ? await checkFleet(m) : [];
  // A machine label that equals OUR OWN prefix can never be reached: `routeFor` resolves it locally
  // first (it must — ssh to ourselves lands in a different ccmux). Cloned configs make this easy to
  // do by accident, and the symptom is the original incident: a reply "to the other box" delivered
  // to a local same-named session.
  const selfLabelled = Object.keys(fleet).includes(m.rcPrefix);
  // The wire has one prerequisite ssh does not: a LOCAL agent holding this machine's connection.
  // Without it every wire peer reads as "unreachable", which sends the reader looking at the far
  // machine for a fault that is on this one.
  const wireSocket = wireSocketPath(m);
  const wireExpected = peers.some((p) => p.via === "wire");
  const wireReady = wireSocket !== null && existsSync(wireSocket);

  if (json) {
    console.log(
      JSON.stringify({
        version: VERSION,
        generatedAt: new Date().toISOString(),
        os: PLATFORM,
        self: SELF_DISPLAY,
        promptInvocation: promptInvocation(),
        configFile,
        mutedChat: mutedChatSessions(m),
        unhonourableModes: unhonourableModes(m, UID === 0),
        stateDir: m.stateDir,
        dataDir: DATA_DIR,
        cacheDir: CACHE_DIR,
        bundle: { path: APP_BUNDLE, present: bundlePresent() },
        rcPrefix: m.rcPrefix,
        bootLabel: m.bootLabel,
        bins: { claude: m.claudeBin, codex: m.codexBin ?? null, tmux: m.tmuxBin },
        deps: { claude: claudeOk, codex: codexOk, tmux: tmuxOk },
        fleet: fleetChecks,
        fleetSelfLabelled: selfLabelled,
        wire: wireExpected ? { socket: wireSocket, ready: wireReady } : null,
        daemon,
      }),
    );
    return 0;
  }

  console.log(`ccmux ${VERSION}`);
  console.log(`self:       ${SELF_DISPLAY}`);
  console.log(`agent cli:  ${promptInvocation()}`);
  // The three roots, named, because "where does this thing keep its files" used to be answerable
  // only by hunting through a home directory — and the answer differed per machine.
  console.log(`config:     ${configFile}`);
  console.log(`state:      ${m.stateDir}`);
  console.log(`code:       ${DATA_DIR}`);
  console.log(`cache:      ${CACHE_DIR}`);
  console.log(`rc prefix:  ${m.rcPrefix}`);
  console.log(`boot label: ${m.bootLabel}`);
  console.log(`claude: ${m.claudeBin} (${claudeOk ? "ok" : "missing"})`);
  console.log(`codex:  ${m.codexBin ?? "—"} (${m.codexBin ? (codexOk ? "ok" : "missing") : "not set"})`);
  console.log(`tmux:   ${m.tmuxBin} (${tmuxOk ? "ok" : "missing"})`);
  if (fleetChecks.length > 0) {
    console.log("fleet:");
    for (const c of fleetChecks) {
      const mark = c.ok ? "ok" : c.reachable ? "PROBLEM" : "unreachable";
      const route = c.via === "wire" ? "via wire" : `→ ${c.alias}`;
      console.log(`  ${c.machine} ${route} (${mark})${c.ok ? "" : ` — ${c.detail}`}`);
    }
    if (selfLabelled) {
      console.log(`  PROBLEM — '${m.rcPrefix}' is this machine's own rcPrefix, so '${m.rcPrefix}:<session>' always resolves LOCALLY and that entry is dead. Give each machine a distinct rcPrefix.`);
    }
  }
  if (wireExpected) {
    console.log(`wire:   ${wireReady ? `agent socket ${wireSocket}` : `PROBLEM — no agent socket at ${wireSocket ?? "(unknown)"}; start 'stitchwire agent' on this machine`}`);
  }
  const unhonourable = unhonourableModes(m, UID === 0);
  if (unhonourable.length > 0) {
    console.log(`perms:  PROBLEM — configured but impossible here: ${unhonourable.join(", ")}`);
    console.log(`        ${escalationRefusal("bypassPermissions", true) ?? ""}`);
  }
  const muted = mutedChatSessions(m);
  if (muted.length > 0) {
    console.log(
      `chat:   PROBLEM — ${muted.length} session(s) can receive but NOT send (started before the send capability existed): ${muted.join(", ")}`,
    );
    console.log(`        fix: ccmux restart ${muted[0]}   (the capability is handed out at launch)`);
  }
  const waiting = await sessionsAtPrompt(m);
  if (waiting.length > 0) {
    console.log(`prompt: PROBLEM — ${waiting.length} session(s) sitting at a menu, unable to act until it is answered:`);
    for (const w of waiting) console.log(`        ${w.name} — ${w.question}`);
    console.log("        These read as 'idle' to every other signal. Answer in the pane, or set trustPrompt in machine.json so the supervisor answers the ones it is allowed to.");
  }
  if (!bundlePresent()) {
    console.log(`bundle: PROBLEM — nothing at ${APP_BUNDLE}, which is what the boot unit and the 'ccmux' shim both launch.`);
    console.log("        A running daemon serves from memory, so the fleet looks healthy until something restarts it.");
    console.log("        fix: ccmux update   (restores it), or reinstall: curl -fsSL <releaseUrl>/../install.sh | bash");
  }
  console.log(`daemon: ${daemon.state}${daemon.manager ? ` (${daemon.manager})` : ""}`);
  return 0;
}

/**
 * Which chat-enabled sessions cannot actually send.
 *
 * Sending is authenticated by a capability handed to the session at launch; a session started before
 * that existed keeps running and keeps RECEIVING, so nothing looks wrong until someone tries to reply
 * and hits a refusal. Asked here as a FACT about the machine rather than inferred from a stamp: the
 * capability either exists for that session or it does not.
 */
export function mutedChatSessions(m: MachineConfig): string[] {
  return loadSessions(m)
    .filter((s) => chatEnabledFor(s, m) && !s.archived && !existsSync(chatAuthPath(m, s.name)))
    .map((s) => s.name);
}

/**
 * Settings that can never take effect on this machine.
 *
 * A hand-edited config can still ask for an escalated mode under a root daemon; the launcher
 * downgrades it, and without this the box would look configured one way while behaving another —
 * the exact confusion that cost a live server an hour.
 */
export function unhonourableModes(m: MachineConfig, isRoot: boolean): string[] {
  const out: string[] = [];
  if (escalationRefusal(m.permissionMode, isRoot, m.allowEscalatedUnderRoot) !== null) out.push(`machine default '${m.permissionMode}'`);
  for (const s of loadSessions(m)) {
    if (s.permissionMode !== undefined && escalationRefusal(s.permissionMode, isRoot, m.allowEscalatedUnderRoot) !== null) {
      out.push(`${s.name} → '${s.permissionMode}'`);
    }
  }
  return out;
}
