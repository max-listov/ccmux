import { dirname } from "node:path";
import { accessSync, constants } from "node:fs";
import type { MachineConfig, Session } from "../../types.ts";
import { buildPrompt } from "../managePrompt.ts";
import { UID } from "../../env.ts";
import { ensurePath, loginShellPath, ensureUtf8Locale } from "../../util/envPath.ts";
import { CHAT_CREDENTIAL_ENV } from "../../chat/auth.ts";

export const CODEX_LAUNCH_MARKER_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";

export function preflight(m: MachineConfig): void {
  if (!m.codexBin) throw new Error("codexBin not configured — set it in machine.json for agent=codex sessions");
  if (!m.codexHome) throw new Error("codexHome not configured — set it in machine.json for agent=codex sessions");
  if (!m.codexSessionsDir) throw new Error("codexSessionsDir not configured — set it in machine.json for agent=codex sessions");
  accessSync(m.codexBin, constants.X_OK);
  accessSync(m.codexSessionsDir, constants.R_OK | constants.W_OK);
}

/**
 * Codex argv. Codex has no `--session-id` (it mints its OWN rollout id on a fresh session) and no
 * `--append-system-prompt`, so the launch shape differs from Claude:
 *
 *  - FIRST launch: `codex [flags] "<prompt>"` — inject the ccmux management instructions as the
 *    leading positional PROMPT (Codex's only injection point). A pending bootstrap stamps a unique
 *    originator marker into `session_meta` and promotes only that exact rollout into the registry.
 *  - RESUME: `codex resume <uuid> [flags]` (Codex resumes by UUID; ids take precedence over names).
 *    NO prompt on resume — re-passing it would open a fresh user turn on every daemon heal.
 *
 * There is no `-n`/RC equivalent for Codex (no claude.ai Remote Control), so RC naming is Claude-only.
 */
export function buildArgv(s: Session, m: MachineConfig, cli: string, historyPresent: boolean): string[] {
  const bin = m.codexBin;
  if (!bin) throw new Error("codexBin not configured — set it in machine.json for agent=codex sessions");
  const flags = UID === 0 ? stripDangerous(s.flags) : s.flags; // root guard (servers)
  if (historyPresent) {
    return [bin, "resume", s.uuid, ...flags, ...m.extraFlags];
  }
  const prompt = buildPrompt(s.name, cli, s.agent, "ccmux", s.chatEnabled, s.promptModules, m.ownerLang, m.rcPrefix);
  return [bin, ...flags, ...m.extraFlags, prompt];
}

function managedFlags(s: Session, m: MachineConfig): string[] {
  return [...(UID === 0 ? stripDangerous(s.flags) : s.flags), ...m.extraFlags];
}

/** Bootstrap argv for adopting an existing Codex identity. No prompt is appended: adoption owns
 * lifecycle only and must not manufacture a hidden user turn in the source conversation. */
export function buildAdoptArgv(s: Session, m: MachineConfig, sourceThreadId: string): string[] {
  const bin = m.codexBin;
  if (!bin) throw new Error("codexBin not configured — set it in machine.json for agent=codex sessions");
  return [bin, "resume", sourceThreadId, ...managedFlags(s, m)];
}

/** Provider-native fork. The management prompt is an explicit first turn of the NEW identity; the
 * source rollout is read by Codex and never copied or renamed by ccmux. */
export function buildForkArgv(
  s: Session,
  m: MachineConfig,
  sourceThreadId: string,
  cli: string,
  launchMarker: string,
): string[] {
  const bin = m.codexBin;
  if (!bin) throw new Error("codexBin not configured — set it in machine.json for agent=codex sessions");
  const prompt = `${buildPrompt(s.name, cli, s.agent, "ccmux", false, [], m.ownerLang, m.rcPrefix)}\n\nccmux launch correlation: ${launchMarker}`;
  return [bin, "fork", sourceThreadId, ...managedFlags(s, m), prompt];
}

// Codex's own "skip every guardrail" switches — refused for the root daemon (servers) so a config
// edit can't hand a server session host-wide power. Mirrors the Claude root guard.
function stripDangerous(flags: string[]): string[] {
  return flags.filter(
    (f) => f !== "--dangerously-bypass-approvals-and-sandbox" && f !== "--dangerously-bypass-hook-trust",
  );
}

/** Environment for the spawned codex: usable PATH + the self-guard marker. */
/** Same two keys as every managed provider: the identity pin and the chat capability. */
export function launchEnvKeys(_m: MachineConfig): readonly string[] {
  return [CHAT_CREDENTIAL_ENV, "CCMUX_SESSION"];
}

export function launchEnv(m: MachineConfig, sessionName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const extra = [m.codexBin ? dirname(m.codexBin) : "", dirname(m.tmuxBin)].filter((p) => p !== "");
  const login = loginShellPath(); // re-derive the real login PATH (fish-aware) under a thin boot PATH
  const base = [login, env.PATH].filter((p): p is string => p !== null && p !== undefined).join(":");
  env.PATH = ensurePath(base, extra);
  ensureUtf8Locale(env); // force UTF-8 so the agent draws Unicode box-rules, not ASCII '_'
  if (m.codexHome) env.CODEX_HOME = m.codexHome;
  env.CCMUX_SESSION = sessionName;
  return env;
}
