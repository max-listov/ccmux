import { existsSync } from "node:fs";
import { Glob } from "bun";
import type { MachineConfig, Session } from "../../types.ts";

/**
 * Locate a Codex session's rollout transcript. Codex names rollout files
 * `rollout-<ts>-<id>.jsonl` under ~/.codex/sessions/Y/M/D/. After pending bootstrap promotion,
 * the registry uuid IS Codex's rollout id, so the glob finds it. Returns null when no
 * rollout exists. A ready managed Codex session must always resolve this path.
 */
export function historyFile(s: Session, m: MachineConfig): string | null {
  const root = m.codexSessionsDir;
  if (!root || !existsSync(root)) return null;
  const glob = new Glob(`**/rollout-*-${s.uuid}.jsonl`);
  for (const f of glob.scanSync({ cwd: root, absolute: true })) return f;
  return null;
}
