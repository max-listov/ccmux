import { readdirSync, statSync } from "node:fs";
import type { MachineConfig, Session } from "../../types.ts";
import { rec, str } from "../normalize.ts";
import { readHeadLines, readTailLines } from "../../util/readLines.ts";
import { encodeDir, histFile } from "./resume.ts";

// ── follow the fork ─────────────────────────────────────────────────────────────
// ccmux pins one uuid per session, but Claude Code does NOT keep that uuid forever:
// when a conversation runs out of context (and in other undocumented cases), sending
// the next message FORKS it — a NEW session id, a NEW jsonl materialized with the old
// tail copied in, while the supervised pane process still says `--resume <old>` in its
// argv. From that moment the registry uuid is a dead file: previews/activity/transcript
// freeze, and the next restart would resume a days-old conversation. (Observed live on
// 2026-07-14: e8f056d3 → 711f8574 under Claude's bg-pty-host daemon, v2.1.208.)
//
// Detection is trigger-agnostic — we don't assume WHY Claude forked, only observe WHERE
// the conversation lives now. The identity key is ccmux's own: every launch passes
// `-n <rcName>` and Claude writes it into the transcript as a `custom-title` event,
// which a fork inherits in its FIRST lines (the materialized copy starts with it).
// So "the current conversation of session X" = the jsonl in X's project dir whose head
// carries X's rc title and whose last message is the newest.

const HEAD_BYTES = 16 * 1024; // the custom-title event sits in a fork's first lines
const TAIL_LINES = 50; // enough to find the newest timestamped record

/** The `customTitle` of a custom-title event found in the file's head, else null. */
function headTitle(lines: string[]): string | null {
  for (const raw of lines) {
    if (!raw) continue;
    let entry: Record<string, unknown> | null = null;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue; // head slice may cut the last line — fine, titles sit at the top
    }
    if (!entry) continue;
    if (str(entry.type) === "custom-title") return str(entry.customTitle);
  }
  return null;
}

/** Newest `timestamp` in the file's tail (epoch ms), or null if none. Timestamps — not
 *  mtime: a desktop-app open bumps mtime without the conversation actually moving. */
export function lastMessageMs(path: string): number | null {
  const lines = readTailLines(path, TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw) continue;
    let entry: Record<string, unknown> | null = null;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!entry) continue;
    const ts = str(entry.timestamp);
    if (ts === null) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/**
 * If the session's conversation moved to a new uuid, return that uuid; else null.
 *
 * A candidate must clear EVERY guard — when in doubt we return null and keep the pin:
 *  - lives in the session's project dir and is a `<uuid>.jsonl` (forks always are);
 *  - not the pinned uuid, and not pinned by ANY other managed session (`takenUuids`);
 *  - its HEAD carries a custom-title equal to this session's rc title (ccmux's own
 *    launch stamp — forks inherit it in their first lines; two sessions sharing one
 *    dir have different rc titles, so they can never claim each other's forks);
 *  - its newest message is STRICTLY newer than the pinned file's (equal → no move).
 * Among several qualifying files (a fork of a fork), the newest wins.
 */
export function detectFork(
  s: Session,
  m: MachineConfig,
  rcTitle: string,
  takenUuids: ReadonlySet<string>,
): string | null {
  const projDir = `${m.projectsDir}/${encodeDir(s.dir)}`;
  let files: string[];
  try {
    files = readdirSync(projDir);
  } catch {
    return null;
  }
  const pinnedMs = lastMessageMs(histFile(s.dir, s.uuid, m.projectsDir)) ?? Number.NEGATIVE_INFINITY;
  let best: { uuid: string; ms: number } | null = null;
  for (const fn of files) {
    if (!UUID_JSONL_RE.test(fn)) continue;
    const uuid = fn.slice(0, -6);
    if (uuid === s.uuid || takenUuids.has(uuid)) continue;
    const path = `${projDir}/${fn}`;
    // stat pre-filter: mtime is always ≥ the newest record's timestamp, so a file whose
    // mtime is not past the pin can't qualify — the daemon tick (30s) stats instead of
    // reading heads/tails of every transcript sharing the project dir.
    try {
      if (statSync(path).mtimeMs <= pinnedMs) continue;
    } catch {
      continue;
    }
    if (headTitle(readHeadLines(path, HEAD_BYTES)) !== rcTitle) continue;
    const ms = lastMessageMs(path);
    if (ms === null || ms <= pinnedMs) continue;
    if (best === null || ms > best.ms) best = { uuid, ms };
  }
  return best?.uuid ?? null;
}
