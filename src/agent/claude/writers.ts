// Live-WRITER detection for a conversation uuid. A session is not just a jsonl — it may
// have 0..N running processes holding it in memory. Two simultaneous writers FORK the
// conversation at the experience level (each keeps its own in-memory state; appends
// interleave but neither sees the other's turns). So adopt must know who's writing.
//
// Detection: scan `ps` for `--resume <uuid>` / `--session-id <uuid>`. Classification by
// binary path (proven on the 2026-06-10 fork incident):
//   …/claude.app/Contents/MacOS/claude  → the Claude DESKTOP app driving the convo
//   …/Helpers/disclaimer …              → the desktop LAUNCHER (same logical writer — dedup)
//   anything else (~/.local/bin/claude) → a CLI instance (terminal / tmux / ccmux itself)
// "self" = the writer is an ANCESTOR of this very process — adopting/killing it would be
// sawing the branch we sit on.

export interface PsProc {
  pid: number;
  ppid: number;
  command: string;
}

export type WriterKind = "desktop" | "cli" | "self";

export interface Writer {
  pid: number;
  kind: WriterKind;
  command: string;
}

/** Parse `ps -ax -o pid=,ppid=,command=` output lines. */
export function parsePs(out: string): PsProc[] {
  const procs: PsProc[] = [];
  for (const line of out.split("\n")) {
    const mm = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!mm) continue;
    const pid = Number(mm[1]);
    const ppid = Number(mm[2]);
    const command = mm[3] ?? "";
    if (Number.isFinite(pid) && Number.isFinite(ppid)) procs.push({ pid, ppid, command });
  }
  return procs;
}

const RESUME_UUID_RE = /--(?:resume|session-id)[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Every conversation uuid that a live process is currently resuming, from a ps snapshot.
 *  This is the AUTHORITATIVE "is a session running right now" signal — far more reliable than a
 *  transcript's file mtime (which a desktop-app open/delete can bump without the session being
 *  alive). Covers both CLI (`~/.local/bin/claude --resume X`) and desktop
 *  (`claude.app/.../claude … --resume X`) — both carry the uuid on their command line. */
export function resumingUuids(procs: PsProc[]): Set<string> {
  const out = new Set<string>();
  for (const p of procs) {
    for (const m of p.command.matchAll(RESUME_UUID_RE)) {
      if (m[1] !== undefined) out.add(m[1]);
    }
  }
  return out;
}

/** Walk the parent chain of `fromPid` and collect every ancestor pid (incl. itself). */
function ancestorsOf(procs: PsProc[], fromPid: number): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  let pid = fromPid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const p = byPid.get(pid);
    if (!p) break;
    pid = p.ppid;
  }
  return seen;
}

/** Pure classification: ps snapshot + uuid → unique logical writers. The desktop launcher
 *  (`Helpers/disclaimer`) wraps the real desktop process — it's the SAME logical writer, so
 *  it's dropped. `selfPid` (this process) marks ancestor-writers as "self". */
export function classifyWriters(procs: PsProc[], uuid: string, selfPid: number): Writer[] {
  const ancestors = ancestorsOf(procs, selfPid);
  const out: Writer[] = [];
  for (const p of procs) {
    if (!p.command.includes(`--resume ${uuid}`) && !p.command.includes(`--session-id ${uuid}`)) continue;
    if (p.command.includes("Helpers/disclaimer")) continue; // launcher = dup of the app process
    const kind: WriterKind = ancestors.has(p.pid)
      ? "self"
      : p.command.includes("claude.app/Contents/MacOS")
        ? "desktop"
        : "cli";
    out.push({ pid: p.pid, kind, command: p.command });
  }
  return out;
}

/** A host started as plain `claude` (fresh conversation) has NO uuid on its cmdline — the
 *  ps scan can't see it. But Claude Code exports CLAUDE_CODE_SESSION_ID to its children, so
 *  when the TARGET uuid is the very conversation we're running in, add a synthetic "self"
 *  writer. One addition covers every guard: cold adopt refuses, the TUI hides takeover,
 *  takeoverAdopt refuses. */
export function addEnvSelf(writers: Writer[], uuid: string, envUuid: string | undefined, selfPid: number): Writer[] {
  if (envUuid !== uuid || writers.some((w) => w.kind === "self")) return writers;
  return [...writers, { pid: selfPid, kind: "self", command: "(this very conversation — via CLAUDE_CODE_SESSION_ID)" }];
}

/** Live writers of `uuid` right now (empty array = the jsonl is dormant, safe to adopt). */
export async function liveWriters(uuid: string): Promise<Writer[]> {
  const proc = Bun.spawn(["ps", "-ax", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const writers = classifyWriters(parsePs(out), uuid, process.pid);
  return addEnvSelf(writers, uuid, process.env.CLAUDE_CODE_SESSION_ID, process.pid);
}

/** One-line human description for a confirm prompt: "desktop app (pid 13457)" etc. */
export function describeWriter(w: Writer): string {
  if (w.kind === "desktop") return `desktop app (pid ${w.pid})`;
  if (w.kind === "self") return `THIS session's own process (pid ${w.pid})`;
  return `cli instance (pid ${w.pid})`;
}
