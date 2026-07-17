import { dirname } from "node:path";
import type { MachineConfig, Session } from "../../types.ts";
import { ensurePath, loginShellPath, ensureUtf8Locale } from "../../util/envPath.ts";

/**
 * Codex argv. Resume by the pinned uuid when a rollout already exists, else start
 * fresh.
 *
 * ⚠️ Known gap (codex-launch spike): on a brand-new session Codex assigns its OWN id,
 * not our uuid, so `resume.ts` can't locate that first rollout until the ids are
 * reconciled. RC (`-n` equiv) and sibling-prompt injection are also not wired for
 * Codex yet — Codex has no `--append-system-prompt`. Reading (transcript/pane/locate)
 * is already 1:1; this is the one place that needs runtime verification.
 */
export function buildArgv(s: Session, m: MachineConfig, _cli: string, historyPresent: boolean): string[] {
  const bin = m.codexBin;
  if (!bin) throw new Error("codexBin not configured — set it in machine.json for agent=codex sessions");
  const resume = historyPresent ? ["resume", s.uuid] : [];
  return [bin, ...resume, ...s.flags, ...m.extraFlags];
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
