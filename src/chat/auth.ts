import { randomUUID, timingSafeEqual } from "node:crypto";
import { PLATFORM } from "../env.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chatAuthPath } from "../config/paths.ts";
import type { MachineConfig, Session } from "../types.ts";

export const CHAT_CREDENTIAL_ENV = "CCMUX_CHAT_CREDENTIAL";

/** Rotate the capability every time the managed runtime starts. Descendants inherit it; a shell
 * that merely self-sets CCMUX_SESSION does not become that runtime. This authenticates ccmux
 * process provenance, not a hostile process running as the same OS user (which can read state). */
export function rotateChatCredential(m: MachineConfig, session: Session): string {
  const credential = randomUUID();
  const path = chatAuthPath(m, session.name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${credential}\n`, { mode: 0o600 });
  return credential;
}

export function hasChatCredential(m: MachineConfig, session: Session, supplied: string | undefined): boolean {
  if (supplied === undefined || supplied === "") return false;
  try {
    const expected = readFileSync(chatAuthPath(m, session.name), "utf8").trim();
    const actualBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}

/**
 * A remote receiver must actually descend from sshd. The environment variable a caller could set
 * about its connection is metadata, not evidence; the process tree is. Same-user hostile processes
 * remain outside the trust model either way.
 *
 * The walk reads the tree, it does not shell out per level. Measured before this shape existed: a
 * `ps` per ancestor cost ~7ms on macOS and **~104ms on Linux**, paid synchronously on every inbound
 * remote message — the single most expensive step in delivery, and the only one priced in process
 * spawns. Depth was never the problem (two levels), the spawns were. Caching would not have helped:
 * the receiver is a fresh process per message, so there is nothing to cache across.
 */
export function hasSshdAncestor(startPid = process.ppid): boolean {
  const parentOf = PLATFORM === "linux" ? procParent : psParent;
  let pid = startPid;
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const entry = parentOf(pid);
    if (entry === null) return false;
    if (entry.command === "sshd" || entry.command.startsWith("sshd:")) return true;
    if (!Number.isInteger(entry.parent) || entry.parent <= 0 || entry.parent === pid) return false;
    pid = entry.parent;
  }
  return false;
}

export interface ProcEntry {
  parent: number;
  command: string;
}

/** Linux: the tree is a file read per level — no process spawned at all. */
function procParent(pid: number): ProcEntry | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pure parse of a Linux `stat` line: `pid (comm) state ppid …`.
 *
 * The command is parenthesised and may itself contain spaces AND a closing paren, so splitting on
 * whitespace — or on the first `)` — misreads exactly the processes chosen to be misread. The split
 * is taken at the LAST `)`, which is unambiguous because everything after it is numeric fields.
 */
export function parseProcStat(raw: string): ProcEntry | null {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const parent = Number.parseInt(fields[1] ?? "", 10);
  if (!Number.isInteger(parent)) return null;
  return { parent, command: raw.slice(open + 1, close) };
}

/** Elsewhere (macOS): ask about ONE process per level. Measured against listing the whole table in
 *  one spawn — the full listing was ~5x SLOWER, because the table is hundreds of rows and the walk
 *  is two. The cheap-looking optimisation was the wrong one; the expensive platform was Linux. */
function psParent(pid: number): ProcEntry | null {
  const result = Bun.spawnSync(["ps", "-o", "ppid=", "-o", "comm=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const match = /^(\d+)\s+(.+)$/.exec(result.stdout.toString().trim());
  if (match === null) return null;
  return {
    parent: Number.parseInt(match[1] ?? "", 10),
    command: (match[2] ?? "").split("/").at(-1) ?? "",
  };
}
