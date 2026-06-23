import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { MachineConfig, TranscriptMessage } from "../types.ts";
import { parse, usedTokens } from "../agent/claude/transcript.ts";
import { parsePs, resumingUuids } from "../agent/claude/writers.ts";
import { readTailLines } from "../agent/index.ts";
import { loadSessions } from "../config/sessions.ts";
import { rec, str } from "../agent/normalize.ts";
import { MtimeCache } from "../util/mtimeCache.ts";

// Discover LIVE Claude sessions running OUTSIDE ccmux. A session is "live" iff a process is
// actually RESUMING its uuid right now (ps scan) — NOT merely "the jsonl file was touched
// recently". File mtime lies: a desktop-app open/delete bumps it without the session running, so
// the old mtime<20min heuristic surfaced dead sessions. We take the authoritative signal (a live
// process), then read just enough of its transcript to show it: cwd, last activity, model, tokens,
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

const HEAD_BYTES = 64 * 1024; // enough to hold the session's cwd (usually line 1) without a full read
const TAIL_LINES = 2000; // model / tokens / last message all live in the tail (matches managed window)

/** uuids with a live `claude --resume`/`--session-id` process right now (sync — discover is sync). */
function liveUuids(): Set<string> {
  try {
    const r = Bun.spawnSync(["ps", "-ax", "-o", "pid=,ppid=,command="]);
    if (!r.success) return new Set();
    return resumingUuids(parsePs(r.stdout.toString()));
  } catch {
    return new Set();
  }
}

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

export function discoverActive(m: MachineConfig): DiscoveredSession[] {
  const root = m.projectsDir;
  if (!existsSync(root)) return [];
  const managed = new Set(loadSessions(m).map((s) => s.uuid));
  // AUTHORITATIVE liveness: only uuids with a running process, minus the ones ccmux manages
  // (those have their own section). No live external process → nothing to discover, and we skip
  // the whole directory scan + file reads. This is also the cheap common case.
  const targets = new Set([...liveUuids()].filter((u) => !managed.has(u)));
  if (targets.size === 0) return [];
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
      if (!targets.has(uuid)) continue; // only sessions with a LIVE process
      const path = `${projDir}/${fn}`;
      const ds = cache.get(path, () => {
        const tail = readTailLines(path, TAIL_LINES);
        if (tail.length === 0) return null;
        const msgLines = tail.length > 120 ? tail.slice(-120) : tail;
        const msgs = parse(msgLines, 1, 280);
        const lastMessage = msgs.length > 0 ? (msgs[msgs.length - 1] ?? null) : null;
        // "last activity" = the last MESSAGE's timestamp, not the file mtime (which a UI touch can
        // bump without a real turn). Falls back to mtime only if the message carries no timestamp.
        const msgTs = lastMessage?.createdAt ? Date.parse(lastMessage.createdAt) : NaN;
        let lastActivityMs = msgTs;
        if (!Number.isFinite(lastActivityMs)) {
          try {
            lastActivityMs = statSync(path).mtimeMs;
          } catch {
            lastActivityMs = Date.now();
          }
        }
        return {
          uuid,
          dir: firstCwd(readHead(path, HEAD_BYTES)) ?? firstCwd(tail) ?? "?",
          path,
          lastActivityMs,
          model: lastModel(tail),
          usedTokens: usedTokens(tail),
          lastMessage,
        };
      });
      if (ds) out.push(ds);
    }
  }
  // Stable order: by display name (dir basename, then uuid). Sorting by lastActivityMs
  // made cards swap places on every poll tick as different agents wrote — unusable nav.
  return out.sort((a, b) => basename(a.dir).localeCompare(basename(b.dir)) || a.uuid.localeCompare(b.uuid));
}
