import { accessSync, constants, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, MachineConfig } from "../../types.ts";
import { rcName } from "../../config/machine.ts";
import { buildPrompt } from "../managePrompt.ts";
import { UID, HOME } from "../../env.ts";
import { ensurePath, loginShellPath, ensureUtf8Locale } from "../../util/envPath.ts";
import { CHAT_CREDENTIAL_ENV } from "../../chat/auth.ts";

export function preflight(m: MachineConfig): void {
  accessSync(m.claudeBin, constants.X_OK);
}

/**
 * The full claude argv. Pure (resume branch decided by `historyPresent`, computed by
 * the caller each loop). Per-session + fleet flags go straight in as array elements —
 * no shell, so weird flags like `--model claude-opus-4-8[1m]` are never glob-expanded.
 */
export function buildArgv(
  s: Session,
  m: MachineConfig,
  cli: string,
  historyPresent: boolean,
): string[] {
  const resume = historyPresent ? ["--resume", s.uuid] : ["--session-id", s.uuid];
  const flags = UID === 0 ? stripDangerous(s.flags) : s.flags; // same rule, other route
  return [
    m.claudeBin,
    ...resume,
    "-n",
    rcName(m, s.name),
    "--permission-mode",
    // per-session override wins over the machine default; undefined → machine default.
    resolvePermissionMode(s.permissionMode ?? m.permissionMode, UID === 0),
    "--append-system-prompt",
    buildPrompt(s.name, cli, s.agent, "ccmux", s.chatEnabled, s.promptModules, m.ownerLang, m.rcPrefix),
    ...settingsArg(m, s, cli),
    ...flags,
    ...m.extraFlags,
  ];
}

/**
 * The single `--settings` object (or nothing). Two independent needs merge here so we never pass
 * `--settings` twice:
 *  - RC off (dev/isolated instances) → `disableRemoteControl` so their sessions don't surface in
 *    the claude.ai app next to prod ones.
 *  - chat enabled → a Stop hook (`<cli> stop-hook`) that delivers DEFERRED mail at end-of-turn. The
 *    command is the same `cli` invocation the injected prompt uses, so it resolves to the dev source
 *    in an isolated instance and the prod shim otherwise (never a versioned bundle path). Claude
 *    merges this PER-EVENT with the user's own settings — verified it does not clobber their other
 *    hooks (e.g. a global PostToolUse). Gated on chatEnabled so the chat-off fleet pays nothing;
 *    like the chat prompt-framing, it takes effect on the next restart after `ccmux chat on`.
 */
function settingsArg(m: MachineConfig, s: Session, cli: string): string[] {
  const settings: Record<string, unknown> = {};
  if (!m.remoteControl) settings.disableRemoteControl = true;

  // Structured status (ALWAYS injected). Turn-boundary hooks → a working/idle lifecycle file;
  // SessionStart → idle so a resume/restart clears a stale `working` (Stop never fires on interrupt).
  // The statusLine tee captures Claude's own context%/model/cost JSON into a metrics file AND renders
  // the user's original statusline unchanged. Together list/TUI read authoritative status instead of
  // scraping the pane. `hook-status` is SILENT (writes a file, no stdout) so it coexists on the Stop
  // event with the chat `stop-hook`, which owns the `{decision:block}` stdout channel — both run.
  const stopHooks: Array<{ type: string; command: string }> = [];
  if (s.chatEnabled) stopHooks.push({ type: "command", command: `${cli} stop-hook` });
  stopHooks.push({ type: "command", command: `${cli} hook-status` });
  settings.hooks = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `${cli} hook-status` }] }],
    SessionStart: [{ hooks: [{ type: "command", command: `${cli} hook-status` }] }],
    Stop: [{ hooks: stopHooks }],
  };
  settings.statusLine = { type: "command", command: `${cli} status-line` };

  return Object.keys(settings).length > 0 ? ["--settings", JSON.stringify(settings)] : [];
}

// Escalated modes that bypass permission gating entirely — a compromised session under
// root could touch the whole host, so we refuse them for the root daemon (servers).
const ESCALATED_MODES = new Set(["bypassPermissions", "dontAsk"]);

/**
 * Escalated modes are impossible under a root daemon — this is the LAST line, not the only one.
 *
 * Learned the hard way, on a live server. The guard used to downgrade silently, so a machine
 * configured for `bypassPermissions` ran everything as `auto` and nothing explained why. Trying to
 * make it the owner's choice — an explicit per-machine opt-out — was shipped, deployed, and undone
 * within the hour: **the provider itself refuses the mode under root**
 * (`--dangerously-skip-permissions cannot be used with root/sudo privileges`), so lifting our guard
 * did not grant the capability. It put every session on that box into a crash loop.
 *
 * So the mode is not a policy ccmux may choose to allow: it cannot work here at all. Which is why
 * the real fix lives at the SETTING surface (`ccmux mode` refuses it, `doctor` names anything
 * already configured that way) rather than here. This function stays as defence in depth for a
 * hand-edited config, and it must stay silent-but-safe: a launcher is the wrong place to argue.
 */
/**
 * Why this mode cannot be used here — or null when it can.
 *
 * Pure, and shared by every surface that lets someone ASK for a mode, so a refusal is worded once
 * and cannot drift between them. The reason names the provider, not ccmux: this is not a policy we
 * chose and could relax, and saying otherwise would send the next person looking for our switch.
 */
export function escalationRefusal(mode: string, isRoot: boolean): string | null {
  if (!isRoot || !ESCALATED_MODES.has(mode)) return null;
  return (
    `'${mode}' cannot run under a root daemon — the agent itself refuses it there ` +
    `("--dangerously-skip-permissions cannot be used with root/sudo privileges"), so a session set to it would never start. ` +
    `Escalated modes need a daemon running as a non-root user.`
  );
}

export function resolvePermissionMode(mode: string, isRoot: boolean): string {
  if (isRoot && ESCALATED_MODES.has(mode)) return "auto";
  return mode;
}

/** Same decision, same gate: the flag is escalation by another route, so it lives or dies with it. */
function stripDangerous(flags: string[]): string[] {
  return flags.filter(
    (f) => f !== "--dangerously-skip-permissions" && f !== "--allow-dangerously-skip-permissions",
  );
}

/**
 * Environment for the spawned claude:
 *  - drop ccmux's own Claude Code context so the child doesn't think it's nested
 *  - P1-5: guarantee a usable PATH (claude shells out to git/rg/node) even under a
 *    thin systemd/launchd PATH
 *  - OAuth hygiene: if logged in via OAuth, drop ANTHROPIC_API_KEY so OAuth wins
 */
/** What ccmux itself puts into the child's environment — the identity pin and the chat capability.
 *  Everything else `launchEnv` touches (PATH, locale) is normalisation, not policy, so it is not
 *  part of the recipe a restart would change. */
export function launchEnvKeys(): readonly string[] {
  return [CHAT_CREDENTIAL_ENV, "CCMUX_SESSION"];
}

export function launchEnv(m: MachineConfig, sessionName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (hasOauthAccount()) delete env.ANTHROPIC_API_KEY;
  const login = loginShellPath(); // re-derive the real login PATH (fish-aware) under a thin boot PATH
  const base = [login, env.PATH].filter((p): p is string => p !== null && p !== undefined).join(":");
  env.PATH = ensurePath(base, [dirname(m.claudeBin), dirname(m.tmuxBin)]);
  ensureUtf8Locale(env); // no LANG under launchd → claude draws box-rules as ASCII ('_'); force UTF-8
  // so a ccmux run from inside this session can recognize "self" (block rm/stop self)
  env.CCMUX_SESSION = sessionName;
  return env;
}

function hasOauthAccount(): boolean {
  try {
    const obj: unknown = JSON.parse(readFileSync(`${HOME}/.claude.json`, "utf8"));
    return typeof obj === "object" && obj !== null && "oauthAccount" in obj;
  } catch {
    return false;
  }
}
