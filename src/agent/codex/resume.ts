import { existsSync } from "node:fs";
import { Glob } from "bun";
import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import { readFirstLine } from "../../util/readLines.ts";

const RolloutSessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({ id: z.uuid() }).passthrough(),
}).passthrough();

export type RolloutReadiness =
  | { status: "missing"; path: null; detail: "rollout-missing" }
  | { status: "pending"; path: string; detail: "metadata-unpublished" | "metadata-invalid" }
  | { status: "ready"; path: string; detail: null };

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

/**
 * A rollout path becomes visible before its first JSONL record is necessarily committed. Provider
 * readers treat the newline-terminated `session_meta` record as the publication boundary, so a
 * fresh managed turn must wait for that same boundary instead of treating file existence as ready.
 */
export function rolloutReadiness(s: Session, m: MachineConfig): RolloutReadiness {
  const path = historyFile(s, m);
  if (path === null) return { status: "missing", path: null, detail: "rollout-missing" };
  const first = readFirstLine(path);
  if (first === null) return { status: "pending", path, detail: "metadata-unpublished" };
  try {
    const metadata = RolloutSessionMetaSchema.parse(JSON.parse(first));
    if (metadata.payload.id !== s.uuid) return { status: "pending", path, detail: "metadata-invalid" };
    return { status: "ready", path, detail: null };
  } catch {
    return { status: "pending", path, detail: "metadata-invalid" };
  }
}
