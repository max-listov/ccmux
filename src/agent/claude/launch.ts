import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, MachineConfig } from "../../types.ts";
import { rcName } from "../../config/machine.ts";
import { buildPrompt } from "../managePrompt.ts";
import { UID, HOME } from "../../env.ts";
import { ensurePath, loginShellPath, ensureUtf8Locale } from "../../util/envPath.ts";

/**
 * The full claude argv. Pure (resume branch decided by `historyPresent`, computed by
 * the caller each loop). Per-session + fleet flags go straight in as array elements —
 * no shell, so weird flags like `--model claude-opus-4-8[1m]` are never glob-expanded.
 */
export function buildArgv(
  s: Session,
  m: MachineConfig,
  self: string,
  historyPresent: boolean,
): string[] {
  const resume = historyPresent ? ["--resume", s.uuid] : ["--session-id", s.uuid];
  const flags = UID === 0 ? stripDangerous(s.flags) : s.flags; // root guard
  return [
    m.claudeBin,
    ...resume,
    "-n",
    rcName(m, s.name),
    "--permission-mode",
    // per-session override wins over the machine default; undefined → machine default.
    resolvePermissionMode(s.permissionMode ?? m.permissionMode),
    "--append-system-prompt",
    buildPrompt(s.name, self),
    ...flags,
    ...m.extraFlags,
  ];
}

// Escalated modes that bypass permission gating entirely — a compromised session under
// root could touch the whole host, so we refuse them for the root daemon (servers).
const ESCALATED_MODES = new Set(["bypassPermissions", "dontAsk"]);

/**
 * Root guard for permission mode: on the root daemon (servers) an escalated mode is
 * downgraded to "auto" so a config edit can't hand a server session host-wide power.
 * Non-root daemons (personal Macs) honor whatever the machine config asks for.
 */
function resolvePermissionMode(mode: string): string {
  if (UID === 0 && ESCALATED_MODES.has(mode)) return "auto";
  return mode;
}

/** Defensive: we never add it, but strip it if a config tries to, when running as root. */
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
