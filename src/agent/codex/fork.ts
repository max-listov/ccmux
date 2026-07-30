import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Glob } from "bun";
import type { MachineConfig, Session } from "../../types.ts";
import { rec, str } from "../normalize.ts";
import { readHeadLines } from "../../util/readLines.ts";
import { historyFile } from "./resume.ts";

// ── reconcile Codex's self-assigned id ──────────────────────────────────────────────────
// Codex has no `--session-id`: a fresh session mints its OWN rollout id, not the uuid ccmux pinned.
// So on first launch the registry uuid is a placeholder with no rollout. This runs in the SAME
// follow-fork pipeline as Claude (ensure.ts → forkedUuid): once Codex has written its rollout, we
// find it and return its real id, and the daemon re-pins the registry to it. After that the pin
// tracks the actual conversation and `codex resume <uuid>` works.

const ROLLOUT_ID_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const HEAD_BYTES = 16 * 1024; // session_meta (with cwd) is the first record

/** The cwd recorded in a rollout's `session_meta`, or null. */
function rolloutCwd(path: string): string | null {
  for (const raw of readHeadLines(path, HEAD_BYTES)) {
    if (!raw) continue;
    try {
      const entry = rec(JSON.parse(raw));
      if (str(entry?.type) !== "session_meta") continue;
      return str(rec(entry?.payload)?.cwd);
    } catch {
      continue; // head slice may cut the last line — session_meta is line 1
    }
  }
  return null;
}

/**
 * If Codex minted an id we haven't reconciled yet, return it; else null.
 *
 * Only runs while the pin has NO rollout (the placeholder from `ccmux new`); once reconciled,
 * `historyFile` resolves and this short-circuits (so a stable session pays nothing per tick).
 * The match is the newest rollout in the session's cwd whose id no other managed session owns —
 * i.e. the one Codex just created for this launch. (Known edge: two ccmux codex sessions started
 * in the SAME dir within one tick could race on "newest"; `takenUuids` still prevents cross-claim.)
 */
export function detectFork(
  s: Session,
  m: MachineConfig,
  _rcTitle: string,
  takenUuids: ReadonlySet<string>,
): string | null {
  if (historyFile(s, m) !== null) return null; // already reconciled → nothing to follow
  const root = m.codexSessionsDir;
  if (!root || !existsSync(root)) return null;
  let best: { id: string; ms: number } | null = null;
  for (const path of new Glob("**/rollout-*.jsonl").scanSync({ cwd: root, absolute: true })) {
    const id = basename(path).match(ROLLOUT_ID_RE)?.[1];
    if (id === undefined || id === s.uuid || takenUuids.has(id)) continue;
    let ms: number;
    try {
      ms = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (best !== null && ms <= best.ms) continue; // older than a found candidate → skip the head read
    if (rolloutCwd(path) !== s.dir) continue;
    best = { id, ms };
  }
  return best?.id ?? null;
}
