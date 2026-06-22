import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, appendSession } from "../config/sessions.ts";
import { startSession } from "./lifecycle.ts";
import { SessionSchema } from "../config/schema.ts";
import { rec, str } from "../agent/normalize.ts";
import { liveWriters, describeWriter, type Writer } from "../agent/claude/writers.ts";
import type { MachineConfig, Session } from "../types.ts";

// Adopt an EXTERNAL conversation into ccmux. The conversation is a jsonl + 0..N live
// processes; the safe action depends on the writers (see writers.ts):
//   no writers   → COLD adopt: register + resume; ccmux becomes the only writer.
//   live writers → never silently resume (that's a second writer = a forked conversation —
//                  the 2026-06-10 incident). Two EXPLICIT modes instead:
//     fork     — copy the jsonl under a NEW uuid and resume THAT. Original + its writer
//                live on untouched; structurally no conflict. (Verified empirically: claude
//                resumes a byte-copied jsonl under the new filename-uuid, full history.)
//     takeover — kill the writer processes, then cold-adopt. Refused when a writer is an
//                ancestor of this process ("self"). NOTE: a supervised writer may respawn
//                (desktop app behavior unverified) — fork is the safe default.

export interface Transcript {
  path: string;
  dir: string; // the cwd the session ran in
  projDir: string; // ~/.claude/projects/<encoded>
}

/** Locate a uuid's transcript under projectsDir + the cwd it ran in. */
export function findTranscript(m: MachineConfig, uuid: string): Transcript | null {
  const root = m.projectsDir;
  if (!existsSync(root)) return null;
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return null;
  }
  for (const proj of projects) {
    const projDir = `${root}/${proj}`;
    const path = `${projDir}/${uuid}.jsonl`;
    if (!existsSync(path)) continue;
    // scan lines until the first one carrying a cwd (the first line may be a meta/summary row)
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const cwd = str(rec(JSON.parse(raw))?.cwd);
        if (cwd) return { path, dir: cwd, projDir };
      } catch {
        /* skip malformed line */
      }
    }
    return null;
  }
  return null;
}

/** Back-compat helper: just the cwd. */
export function dirForUuid(m: MachineConfig, uuid: string): string | null {
  return findTranscript(m, uuid)?.dir ?? null;
}

function pickName(sessions: Session[], dir: string, wantName: string | undefined, uuid: string): string {
  let name = wantName ?? `cc-${basename(dir)}`;
  if (sessions.some((s) => s.name === name)) name = `${name}-${uuid.slice(0, 4)}`;
  return name;
}

async function register(m: MachineConfig, dir: string, uuid: string, name: string): Promise<string> {
  const s = SessionSchema.parse({ name, dir, uuid });
  await appendSession(m, s);
  await startSession(m, name, dir);
  return name;
}

/** Thrown when a cold adopt would create a second writer — carries the writers so the
 *  caller (CLI/TUI) can offer fork/takeover instead of failing opaquely. */
export class LiveWritersError extends Error {
  writers: Writer[];
  constructor(writers: Writer[]) {
    super(`session has ${writers.length} live writer(s): ${writers.map(describeWriter).join(", ")}`);
    this.writers = writers;
  }
}

/** COLD adopt — only valid when nobody is writing the uuid. Gate enforced here. */
export async function adoptSession(m: MachineConfig, dir: string, uuid: string, wantName?: string): Promise<string> {
  const sessions = loadSessions(m);
  const already = sessions.find((s) => s.uuid === uuid);
  if (already) throw new Error(`already managed as '${already.name}'`);
  const writers = await liveWriters(uuid);
  if (writers.length > 0) throw new LiveWritersError(writers);
  return register(m, dir, uuid, pickName(sessions, dir, wantName, uuid));
}

/** FORK adopt — copy the jsonl under a fresh uuid and manage THAT. Always safe: the
 *  original conversation and whoever is driving it stay untouched. */
export async function forkAdopt(m: MachineConfig, srcUuid: string, wantName?: string): Promise<string> {
  const t = findTranscript(m, srcUuid);
  if (!t) throw new Error(`no transcript found for ${srcUuid}`);
  const sessions = loadSessions(m);
  const newUuid = crypto.randomUUID();
  copyFileSync(t.path, `${t.projDir}/${newUuid}.jsonl`);
  return register(m, t.dir, newUuid, pickName(sessions, t.dir, wantName, newUuid));
}

const TAKEOVER_WAIT_MS = 5000;

/** TAKEOVER adopt — SIGTERM the live writers, wait until they're gone, then cold-adopt.
 *  Refuses when a writer is "self" (an ancestor of this process). A supervised writer
 *  (desktop app / another daemon) may respawn — caller was warned; fork is the default. */
export async function takeoverAdopt(m: MachineConfig, dir: string, uuid: string, wantName?: string): Promise<string> {
  const writers = await liveWriters(uuid);
  const self = writers.find((w) => w.kind === "self");
  if (self) throw new Error(`refusing takeover: ${describeWriter(self)} — you'd kill the session you're in. Use fork.`);
  for (const w of writers) {
    try {
      process.kill(w.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  while (Date.now() < deadline) {
    if ((await liveWriters(uuid)).length === 0) break;
    await Bun.sleep(300);
  }
  const left = await liveWriters(uuid);
  if (left.length > 0) throw new Error(`takeover failed: still alive after SIGTERM: ${left.map(describeWriter).join(", ")}`);
  return adoptSession(m, dir, uuid, wantName);
}

export async function cmdAdopt(args: string[]): Promise<number> {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const rest = args.filter((a) => !a.startsWith("--"));
  const uuid = rest[0];
  if (!uuid) {
    console.log("usage: ccmux adopt <uuid> [name] [--fork | --takeover]");
    return 1;
  }
  const m = loadMachineConfig();
  const t = findTranscript(m, uuid);
  if (!t) {
    console.log(`adopt: no transcript found for ${uuid} under ${m.projectsDir}`);
    return 1;
  }
  try {
    if (flags.has("--fork")) {
      const name = await forkAdopt(m, uuid, rest[1]);
      console.log(`forked ${uuid.slice(0, 8)} as '${name}' (new uuid, original untouched) — resumed in ccmux tmux.`);
      return 0;
    }
    if (flags.has("--takeover")) {
      const name = await takeoverAdopt(m, t.dir, uuid, rest[1]);
      console.log(`took over ${uuid.slice(0, 8)} as '${name}' — previous writer(s) stopped, resumed in ccmux tmux.`);
      console.log("note: a supervised writer (desktop app) may respawn — if the fork returns, close it at the source.");
      return 0;
    }
    const name = await adoptSession(m, t.dir, uuid, rest[1]);
    console.log(`adopted ${uuid.slice(0, 8)} as '${name}' (dir ${t.dir}) — resumed in ccmux tmux.`);
    return 0;
  } catch (e) {
    if (e instanceof LiveWritersError) {
      console.log(`adopt: ${uuid.slice(0, 8)} is LIVE — ${e.writers.map(describeWriter).join(", ")}.`);
      console.log("a second resume would fork the conversation. choose explicitly:");
      console.log(`  ccmux adopt ${uuid} --fork      # safe: copy under a new uuid, original untouched`);
      console.log(`  ccmux adopt ${uuid} --takeover  # kill the writer(s), then adopt the original`);
      return 1;
    }
    console.log(`adopt: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
