import { dirname } from "node:path";
import type { MachineConfig, Session } from "../../types.ts";
import { buildPrompt } from "../managePrompt.ts";
import { UID } from "../../env.ts";
import { ensurePath, loginShellPath, ensureUtf8Locale } from "../../util/envPath.ts";

/**
 * Codex argv. Codex has no `--session-id` (it mints its OWN rollout id on a fresh session) and no
 * `--append-system-prompt`, so the launch shape differs from Claude:
 *
 *  - FIRST launch: `codex [flags] "<prompt>"` — inject the ccmux management instructions as the
 *    leading positional PROMPT (Codex's only injection point). Codex writes a rollout under its own
 *    id; `detectFork` (codex/fork.ts) then reconciles that id back into the registry so the pin
 *    tracks the real conversation — the same follow-fork pipeline Claude uses.
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
  const prompt = buildPrompt(s.name, cli, s.chatEnabled, s.promptModules, m.ownerLang);
  return [bin, ...flags, ...m.extraFlags, prompt];
}

// Codex's own "skip every guardrail" switches — refused for the root daemon (servers) so a config
// edit can't hand a server session host-wide power. Mirrors the Claude root guard.
function stripDangerous(flags: string[]): string[] {
  return flags.filter(
    (f) => f !== "--dangerously-bypass-approvals-and-sandbox" && f !== "--dangerously-bypass-hook-trust",
  );
}

/** Environment for the spawned codex: usable PATH + the self-guard marker. */
export function launchEnv(m: MachineConfig, sessionName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const extra = [m.codexBin ? dirname(m.codexBin) : "", dirname(m.tmuxBin)].filter((p) => p !== "");
  const login = loginShellPath(); // re-derive the real login PATH (fish-aware) under a thin boot PATH
  const base = [login, env.PATH].filter((p): p is string => p !== null && p !== undefined).join(":");
  env.PATH = ensurePath(base, extra);
  ensureUtf8Locale(env); // force UTF-8 so the agent draws Unicode box-rules, not ASCII '_'
  env.CCMUX_SESSION = sessionName;
  return env;
}
