import { loadMachineConfig, rcName } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { readTranscript } from "../agent/index.ts";
import { VERSION } from "../util/version.ts";
import type { TranscriptJson } from "../types.ts";

const USAGE =
  "usage: ccmux transcript <name> --json [--tail N] [--cursor LINE] [--before LINE --limit N]";

interface Opts {
  json: boolean;
  tail: number;
  cursor?: number;
  before?: number;
  limit?: number;
}

function parseOpts(args: string[]): Opts {
  let json = false;
  let tail = 200;
  let cursor: number | undefined;
  let before: number | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--tail") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) tail = n;
    } else if (a === "--cursor") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) cursor = n;
    } else if (a === "--before") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) before = n;
    } else if (a === "--limit") {
      const n = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) limit = n;
    } else if (a !== undefined && /^\d+$/.test(a)) {
      tail = Number.parseInt(a, 10);
    }
  }
  tail = Math.min(Math.max(tail, 1), 1000);
  if (limit !== undefined) limit = Math.min(Math.max(limit, 1), 1000);
  const opts: Opts = { json, tail };
  if (cursor !== undefined) opts.cursor = cursor;
  if (before !== undefined) opts.before = before;
  if (limit !== undefined) opts.limit = limit;
  return opts;
}

export async function cmdTranscript(name: string | undefined, args: string[]): Promise<number> {
  if (!name) {
    console.log(USAGE);
    return 1;
  }
  const o = parseOpts(args);
  if (!o.json) {
    console.log(USAGE);
    return 1;
  }
  const m = loadMachineConfig();
  const s = findSession(loadSessions(m), name);
  if (!s) {
    console.log(`unknown session: ${name}`);
    return 1;
  }
  const readOpts: { tail: number; cursor?: number; before?: number; limit?: number } = {
    tail: o.tail,
  };
  if (o.cursor !== undefined) readOpts.cursor = o.cursor;
  if (o.before !== undefined) readOpts.before = o.before;
  if (o.limit !== undefined) readOpts.limit = o.limit;
  const read = readTranscript(s, m, readOpts);
  const out: TranscriptJson = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    session: { name: s.name, uuid: s.uuid, rc: rcName(m, s.name), dir: s.dir, machine: m.rcPrefix },
    source: {
      kind: read.available ? `${read.agent}-jsonl` : "unavailable",
      path: read.path,
      available: read.available,
      error: read.error,
    },
    cursor: {
      opaque: read.available ? String(read.totalLines) : null,
      line: read.available ? read.totalLines : null,
      byteOffset: null,
      mtimeMs: read.mtimeMs,
    },
    window: {
      firstLine: read.firstLine,
      lastLine: read.totalLines,
      reachedStart: read.reachedStart,
    },
    messages: read.messages,
  };
  console.log(JSON.stringify(out));
  return 0;
}
