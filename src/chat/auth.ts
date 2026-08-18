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
 * A remote receiver must actually descend from an authenticated remote transport.
 *
 * The environment variable a caller could set about its connection is metadata, not evidence; the
 * process tree is. Ancestry is kernel truth — a process cannot choose its own parent — which is why
 * this check is worth its cost and why nothing here reads a variable the caller controls.
 *
 * Two transports qualify, on the same footing:
 *  - **sshd** — the OS authenticated the connection before anything ran.
 *  - **the stitchwire agent** — the daemon that authenticated to the broker with THIS machine's
 *    token, and executes only what this machine's own allowlist names. It exists because ssh cannot
 *    reach a machine with no address, which is every laptop; the connection direction differs, the
 *    strength of the evidence does not.
 *
 * The walk reads the tree, it does not shell out per level. Measured before this shape existed: a
 * `ps` per ancestor cost ~7ms on macOS and **~104ms on Linux**, paid synchronously on every inbound
 * remote message — the single most expensive step in delivery, and the only one priced in process
 * spawns. Depth was never the problem (two levels), the spawns were. Caching would not have helped:
 * the receiver is a fresh process per message, so there is nothing to cache across.
 */
export type RemoteTransport = "ssh" | "wire";

export function remoteTransportAncestor(startPid = process.ppid): RemoteTransport | null {
  const parentOf = PLATFORM === "linux" ? procParent : psParent;
  let pid = startPid;
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const entry = parentOf(pid);
    if (entry === null) return null;
    if (entry.command === "sshd" || entry.command.startsWith("sshd:")) return "ssh";
    if (isStitchwireAgent(entry.args)) return "wire";
    if (!Number.isInteger(entry.parent) || entry.parent <= 0 || entry.parent === pid) return null;
    pid = entry.parent;
  }
  return null;
}

/** Kept as the historical name and shape — every existing caller and test asks a boolean question. */
export function hasSshdAncestor(startPid = process.ppid): boolean {
  return remoteTransportAncestor(startPid) !== null;
}

/**
 * Is this ancestor the stitchwire agent?
 *
 * Matched on the full command line rather than on `comm`, because the agent is launched as
 * `bun /path/stitchwire agent` and its `comm` is therefore `bun` — a name shared with half the
 * fleet. Both tokens are required: the binary, and the `agent` verb. `stitchwire call …` is a
 * CALLER, never a receiver, and must not confer admission on anything descending from it.
 */
export function isStitchwireAgent(args: string): boolean {
  if (args === "") return false;
  const tokens = args.split(/\s+/);
  const hasBinary = tokens.some((t) => t === "stitchwire" || t.endsWith("/stitchwire"));
  return hasBinary && tokens.includes("agent");
}

export interface ProcEntry {
  parent: number;
  command: string;
  /** Full command line, for ancestors whose identity `comm` cannot express. */
  args: string;
}

/** Linux: the tree is a file read per level — no process spawned at all. */
function procParent(pid: number): ProcEntry | null {
  try {
    const entry = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (entry === null) return null;
    // A second cheap file read, and only when the answer is still open: `sshd` is decided by `comm`
    // alone, so the common path pays nothing extra.
    if (entry.command === "sshd" || entry.command.startsWith("sshd:")) return entry;
    return { ...entry, args: readCmdline(pid) };
  } catch {
    return null;
  }
}

/** `/proc/<pid>/cmdline` is NUL-separated and NUL-terminated; splitting on whitespace would merge
 *  an argument that legitimately contains a space with its neighbour. */
function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((s) => s !== "").join(" ");
  } catch {
    return "";
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
  return { parent, command: raw.slice(open + 1, close), args: "" };
}

/** Elsewhere (macOS): ask about ONE process per level. Measured against listing the whole table in
 *  one spawn — the full listing was ~5x SLOWER, because the table is hundreds of rows and the walk
 *  is two. The cheap-looking optimisation was the wrong one; the expensive platform was Linux. */
function psParent(pid: number): ProcEntry | null {
  // `comm` and `args` in the SAME spawn: the command line is needed to recognise an ancestor whose
  // `comm` is only its interpreter, and a second `ps` would double the cost this function was
  // shaped to avoid. `args` must come last — it is the field that contains spaces.
  const result = Bun.spawnSync(["ps", "-o", "ppid=", "-o", "comm=", "-o", "args=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  return parsePsLine(result.stdout.toString().trim());
}

/** `<ppid> <comm> <args…>` — `comm` is a path without spaces, so the first two whitespace-separated
 *  fields are unambiguous and everything after them is the command line. */
export function parsePsLine(line: string): ProcEntry | null {
  const match = /^(\d+)\s+(\S+)\s*(.*)$/.exec(line);
  if (match === null) return null;
  const parent = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(parent)) return null;
  return {
    parent,
    command: (match[2] ?? "").split("/").at(-1) ?? "",
    args: match[3] ?? "",
  };
}
