import { dirname } from "node:path";
import { accessSync, constants } from "node:fs";
import type { MachineConfig, Session } from "../../types.ts";
import { buildPrompt } from "../managePrompt.ts";
import { UID } from "../../env.ts";
import { ensurePath, loginShellPath, ensureUtf8Locale } from "../../util/envPath.ts";
import { CHAT_CREDENTIAL_ENV } from "../../chat/auth.ts";
import { chatEnabledFor } from "../../config/chat.ts";
import { fileSetDigest, ruleSetFiles, tomlTableDigest, type LaunchInput } from "../launchInputs.ts";
import { sessionEnvRecipe } from "../sessionEnv.ts";
import { log } from "../../util/log.ts";
import { isOwnedCodex } from "./ownedPaths.ts";
import { ownedCodexArgv } from "./ownedLaunch.ts";

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
  if (isOwnedCodex(s)) return ownedCodexArgv(s, m, cli);
  const bin = m.codexBin;
  if (!bin) throw new Error("codexBin not configured — set it in machine.json for agent=codex sessions");
  const flags = UID === 0 ? stripDangerous(s.flags) : s.flags; // root guard (servers)
  if (historyPresent) {
    return [bin, "resume", s.uuid, ...flags, ...m.extraFlags];
  }
  const prompt = buildPrompt(s.name, cli, s.agent, "ccmux", chatEnabledFor(s, m), s.promptModules, m.ownerLang, m.rcPrefix);
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

export function launchEnv(m: MachineConfig, session: Session): Record<string, string> {
  // Same recipe as every other provider — the env layer is core-owned precisely so two agents cannot
  // end up with two different answers to "what is this session's environment".
  const { env, refused } = sessionEnvRecipe(session, process.env, process.env.NODE_ENV);
  if (refused.length > 0) log.warn({ msg: "env file tried to set ccmux-controlled names — ignored", name: session.name, keys: refused });
  const extra = [m.codexBin ? dirname(m.codexBin) : "", dirname(m.tmuxBin)].filter((p) => p !== "");
  const login = loginShellPath(); // re-derive the real login PATH (fish-aware) under a thin boot PATH
  const base = [login, env.PATH].filter((p): p is string => p !== null && p !== undefined).join(":");
  env.PATH = ensurePath(base, extra);
  ensureUtf8Locale(env); // force UTF-8 so the agent draws Unicode box-rules, not ASCII '_'
  if (m.codexHome) env.CODEX_HOME = m.codexHome;
  env.CCMUX_SESSION = session.name;
  return env;
}

/**
 * What Codex reads at startup besides argv — same contract as the Claude provider, different files,
 * which is exactly why this belongs to the provider and not to the core.
 *
 * `rules` — the global `AGENTS.md` under this machine's declared Codex home, plus its imports.
 * `mcp` — the `mcp_servers` table of `config.toml`, and only that table: Codex appends a `[projects]`
 * entry to the same file whenever a directory is trusted, so hashing the file would report a
 * configuration change every time somebody opened a new project.
 *
 * A machine with no `codexHome` declared contributes nothing rather than guessing a path: an invented
 * location would hash as permanently absent and quietly disagree with wherever Codex actually reads.
 */
export function launchInputs(_s: Session, m: MachineConfig): LaunchInput[] {
  const home = m.codexHome;
  if (home === undefined) return [];
  const rules = ruleSetFiles(`${home}/AGENTS.md`);
  const config = `${home}/config.toml`;
  return [
    { reason: "rules", label: `global rule set: ${rules.join(", ")}`, digest: fileSetDigest(rules), paths: rules },
    { reason: "mcp", label: `MCP servers: ${config} (mcp_servers)`, digest: tomlTableDigest(config, "mcp_servers"), paths: [config] },
  ];
}
