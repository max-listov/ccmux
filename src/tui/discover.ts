import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { MachineConfig, TranscriptMessage } from "../types.ts";
import { parse, usedTokens } from "../agent/claude/transcript.ts";
import { readTailLines } from "../agent/index.ts";
import { loadSessions } from "../config/sessions.ts";
import { rec, str } from "../agent/normalize.ts";
import { MtimeCache } from "../util/mtimeCache.ts";

// Discover LIVE Claude sessions running OUTSIDE ccmux. We scan ~/.claude/projects for
// transcripts whose file was written recently (= actively in use), skip the ones ccmux
// already manages, and read just enough to show them: cwd, last activity, model, tokens,
// last message. Read-only — we never touch these sessions.

export interface DiscoveredSession {
  uuid: string;
  dir: string;
  path: string;
  lastActivityMs: number;
  model: string | null;
  usedTokens: number | null;
  lastMessage: TranscriptMessage | null;
}

const DEFAULT_MAX_AGE_MS = 20 * 60 * 1000; // "active" = touched in the last 20 min
const HEAD_BYTES = 64 * 1024; // enough to hold the session's cwd (usually line 1) without a full read
const TAIL_LINES = 2000; // model / tokens / last message all live in the tail (matches managed window)

/** First chunk of the file → find the session cwd WITHOUT reading the whole (multi-MB) transcript. */
function readHead(path: string, bytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n).split("\n");
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function firstCwd(lines: string[]): string | null {
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const cwd = str(rec(JSON.parse(raw))?.cwd);
      if (cwd) return cwd;
    } catch {
      // skip (a slice border may have split the last line — fine, cwd is in line 1)
    }
  }
  return null;
}

function lastModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i--) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    try {
      const model = str(rec(rec(JSON.parse(raw))?.message)?.model);
      if (model) return model;
    } catch {
      // skip
    }
  }
  return null;
}

// mtime-keyed: an active external transcript is re-read at most once per WRITE, not every 4s poll.
// Reading the whole multi-MB file each tick was the heaviest IO in the app; now it's a tail slice
// (chunked from the end) plus a 64KB head, only when the file actually moved.
const cache = new MtimeCache<DiscoveredSession | null>();

export function discoverActive(m: MachineConfig, maxAgeMs: number = DEFAULT_MAX_AGE_MS): DiscoveredSession[] {
  const root = m.projectsDir;
  if (!existsSync(root)) return [];
  const managed = new Set(loadSessions(m).map((s) => s.uuid));
  const now = Date.now();
  const out: DiscoveredSession[] = [];

  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projects) {
    const projDir = `${root}/${proj}`;
    let files: string[];
    try {
      files = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const fn of files) {
      if (!fn.endsWith(".jsonl")) continue;
      const uuid = fn.slice(0, -6);
      if (managed.has(uuid)) continue; // managed sessions are shown in their own section
      const path = `${projDir}/${fn}`;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > maxAgeMs) continue; // only recently-active
      const ds = cache.get(path, () => {
        const tail = readTailLines(path, TAIL_LINES);
        if (tail.length === 0) return null;
        const msgLines = tail.length > 120 ? tail.slice(-120) : tail;
        const msgs = parse(msgLines, 1, 280);
        return {
          uuid,
          dir: firstCwd(readHead(path, HEAD_BYTES)) ?? firstCwd(tail) ?? "?",
          path,
          lastActivityMs: mtimeMs,
          model: lastModel(tail),
          usedTokens: usedTokens(tail),
          lastMessage: msgs.length > 0 ? (msgs[msgs.length - 1] ?? null) : null,
        };
      });
      if (ds) out.push(ds);
    }
  }
  // Stable order: by display name (dir basename, then uuid). Sorting by lastActivityMs
  // made cards swap places on every poll tick as different agents wrote — unusable nav.
  return out.sort((a, b) => basename(a.dir).localeCompare(basename(b.dir)) || a.uuid.localeCompare(b.uuid));
}
