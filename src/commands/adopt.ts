import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describeWriter, liveWriters, type Writer } from '../agent/claude/writers.ts';
import { rec, str } from '../agent/normalize.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { AgentKindSchema, SessionSchema } from '../config/schema.ts';
import { appendSession, loadSessions } from '../config/sessions.ts';
import { discoverCodex } from '../external/codex.ts';
import type { ProcessSnapshot } from '../external/processes.ts';
import { processSnapshot } from '../external/processes.ts';
import type { ExternalSession, MachineConfig, Session } from '../types.ts';
import { adoptCodexThread, forkCodexThread } from './create.ts';
import { startSession } from './lifecycle.ts';

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
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
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

function pickName(
  sessions: Session[],
  dir: string,
  wantName: string | undefined,
  uuid: string,
): string {
  let name = wantName ?? `cc-${basename(dir)}`;
  if (sessions.some((s) => s.name === name)) name = `${name}-${uuid.slice(0, 4)}`;
  return name;
}

async function register(
  m: MachineConfig,
  dir: string,
  uuid: string,
  name: string,
): Promise<string> {
  const s = SessionSchema.parse({ name, dir, uuid, agent: 'claude' });
  await appendSession(m, s);
  await startSession(m, name, dir);
  return name;
}

/** Thrown when a cold adopt would create a second writer — carries the writers so the
 *  caller (CLI/TUI) can offer fork/takeover instead of failing opaquely. */
export class LiveWritersError extends Error {
  writers: Writer[];
  constructor(writers: Writer[]) {
    super(
      `session has ${writers.length} live writer(s): ${writers.map(describeWriter).join(', ')}`,
    );
    this.writers = writers;
  }
}

/** COLD adopt — only valid when nobody is writing the uuid. Gate enforced here. */
export async function adoptSession(
  m: MachineConfig,
  dir: string,
  uuid: string,
  wantName?: string,
): Promise<string> {
  const sessions = loadSessions(m);
  const already = sessions.find((s) => s.uuid === uuid);
  if (already) throw new Error(`already managed as '${already.name}'`);
  const writers = await liveWriters(uuid);
  if (writers.length > 0) throw new LiveWritersError(writers);
  return register(m, dir, uuid, pickName(sessions, dir, wantName, uuid));
}

/** FORK adopt — copy the jsonl under a fresh uuid and manage THAT. Always safe: the
 *  original conversation and whoever is driving it stay untouched. */
export async function forkAdopt(
  m: MachineConfig,
  srcUuid: string,
  wantName?: string,
): Promise<string> {
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
export async function takeoverAdopt(
  m: MachineConfig,
  dir: string,
  uuid: string,
  wantName?: string,
): Promise<string> {
  const writers = await liveWriters(uuid);
  const self = writers.find((w) => w.kind === 'self');
  if (self)
    throw new Error(
      `refusing takeover: ${describeWriter(self)} — you'd kill the session you're in. Use fork.`,
    );
  for (const w of writers) {
    try {
      process.kill(w.pid, 'SIGTERM');
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
  if (left.length > 0)
    throw new Error(
      `takeover failed: still alive after SIGTERM: ${left.map(describeWriter).join(', ')}`,
    );
  return adoptSession(m, dir, uuid, wantName);
}

function codexExternal(m: MachineConfig, threadId: string): ExternalSession {
  const item = discoverCodex(m).find((candidate) => candidate.threadId === threadId);
  if (!item)
    throw new Error(`Codex thread ${threadId} is not present in the local external inventory`);
  if (item.storage !== 'stored')
    throw new Error('Codex thread has no persisted rollout and cannot be managed yet');
  return item;
}

export async function adoptCodexExternal(
  m: MachineConfig,
  threadId: string,
  wantName?: string,
): Promise<string> {
  const item = codexExternal(m, threadId);
  const dir = item.dir;
  if (!dir) throw new Error('Codex thread has no persisted cwd and cannot be managed yet');
  const ready = await adoptCodexThread(m, dir, threadId, wantName);
  return ready.name;
}

export async function forkCodexExternal(
  m: MachineConfig,
  threadId: string,
  wantName?: string,
): Promise<string> {
  const item = codexExternal(m, threadId);
  const dir = item.dir;
  if (!dir) throw new Error('Codex thread has no persisted cwd and cannot be managed yet');
  const ready = await forkCodexThread(m, dir, threadId, wantName);
  return ready.name;
}

function sameCodexWriter(before: ExternalSession, after: ExternalSession): boolean {
  const a = before.writerRuntime;
  const b = after.writerRuntime;
  return (
    a?.kind === 'dedicated-cli' &&
    b?.kind === 'dedicated-cli' &&
    a.pid === b.pid &&
    a.startTime === b.startTime &&
    a.processGroup === b.processGroup &&
    after.writerEvidence === 'observed'
  );
}

export type CodexTakeoverDependencies = {
  resolve: (m: MachineConfig, threadId: string) => ExternalSession;
  signal: (pid: number) => void;
  snapshot: () => ProcessSnapshot[] | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  adopt: (m: MachineConfig, dir: string, threadId: string, wantName?: string) => Promise<Session>;
};

const codexTakeoverDependencies: CodexTakeoverDependencies = {
  resolve: codexExternal,
  signal: (pid) => {
    process.kill(pid, 'SIGTERM');
  },
  snapshot: processSnapshot,
  sleep: Bun.sleep,
  now: Date.now,
  adopt: adoptCodexThread,
};

export async function takeoverCodexExternalWithDependencies(
  m: MachineConfig,
  threadId: string,
  confirmedPid: number,
  wantName: string | undefined,
  dependencies: CodexTakeoverDependencies,
): Promise<string> {
  const observed = dependencies.resolve(m, threadId);
  const dir = observed.dir;
  if (!dir) throw new Error('Codex thread has no persisted cwd and cannot be taken over');
  const runtime = observed.writerRuntime;
  if (
    !observed.capabilities.terminateAndAdopt ||
    runtime?.kind !== 'dedicated-cli' ||
    runtime.pid === null
  ) {
    throw new Error(
      'Codex writer is not a proven dedicated CLI; release it at the source and retry adopt',
    );
  }
  if (runtime.pid !== confirmedPid)
    throw new Error(`takeover confirmation must name current writer PID ${runtime.pid}`);
  const fresh = dependencies.resolve(m, threadId);
  if (!sameCodexWriter(observed, fresh))
    throw new Error('Codex writer evidence changed before takeover; nothing was signaled');
  dependencies.signal(runtime.pid);
  const deadline = dependencies.now() + TAKEOVER_WAIT_MS;
  while (dependencies.now() < deadline) {
    const rows = dependencies.snapshot();
    const sameProcess =
      rows?.some((row) => row.pid === runtime.pid && row.startTime === runtime.startTime) ?? true;
    if (!sameProcess) break;
    await dependencies.sleep(50);
  }
  const rows = dependencies.snapshot();
  if (
    rows === null ||
    rows.some((row) => row.pid === runtime.pid && row.startTime === runtime.startTime)
  ) {
    throw new Error('dedicated Codex writer did not exit after SIGTERM');
  }
  // A supervisor/respawn/contender may win after the signal. The bootstrap's real resume admission
  // is still authoritative and will rollback rather than register a second writer.
  const ready = await dependencies.adopt(m, dir, threadId, wantName);
  return ready.name;
}

export async function takeoverCodexExternal(
  m: MachineConfig,
  threadId: string,
  confirmedPid: number,
  wantName?: string,
): Promise<string> {
  return takeoverCodexExternalWithDependencies(
    m,
    threadId,
    confirmedPid,
    wantName,
    codexTakeoverDependencies,
  );
}

export async function cmdAdopt(args: string[]): Promise<number> {
  const providerResult = AgentKindSchema.safeParse(args[0]);
  const uuid = args[1];
  if (
    !providerResult.success ||
    !uuid ||
    (providerResult.data !== 'claude' && providerResult.data !== 'codex')
  ) {
    console.log(
      'usage: ccmux adopt <claude|codex> <uuid> [name] [--fork | --takeover --confirm-writer <pid>]',
    );
    return 1;
  }
  const provider = providerResult.data;
  const fork = args.includes('--fork');
  const takeover = args.includes('--takeover');
  if (fork && takeover) {
    console.log('adopt: choose exactly one of --fork or --takeover');
    return 1;
  }
  const confirmAt = args.indexOf('--confirm-writer');
  const confirmedPid = confirmAt >= 0 ? Number(args[confirmAt + 1]) : null;
  const optionValues = new Set([
    '--fork',
    '--takeover',
    '--confirm-writer',
    confirmAt >= 0 ? args[confirmAt + 1] : undefined,
  ]);
  const name = args.slice(2).find((arg) => arg !== undefined && !optionValues.has(arg));
  const m = loadMachineConfig();
  if (provider === 'codex') {
    try {
      const managed = fork
        ? await forkCodexExternal(m, uuid, name)
        : takeover
          ? Number.isInteger(confirmedPid) && confirmedPid !== null && confirmedPid > 1
            ? await takeoverCodexExternal(m, uuid, confirmedPid, name)
            : (() => {
                throw new Error(
                  '--takeover requires --confirm-writer <pid> from the current inventory',
                );
              })()
          : await adoptCodexExternal(m, uuid, name);
      console.log(
        `${fork ? 'forked' : takeover ? 'took over' : 'adopted'} Codex ${uuid.slice(0, 8)} as '${managed}'`,
      );
      return 0;
    } catch (error) {
      console.log(`adopt: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const t = findTranscript(m, uuid);
  if (!t) {
    console.log(`adopt: no transcript found for ${uuid} under ${m.projectsDir}`);
    return 1;
  }
  try {
    if (fork) {
      const managed = await forkAdopt(m, uuid, name);
      console.log(
        `forked ${uuid.slice(0, 8)} as '${managed}' (new uuid, original untouched) — resumed in ccmux tmux.`,
      );
      return 0;
    }
    if (takeover) {
      const managed = await takeoverAdopt(m, t.dir, uuid, name);
      console.log(
        `took over ${uuid.slice(0, 8)} as '${managed}' — previous writer(s) stopped, resumed in ccmux tmux.`,
      );
      console.log(
        'note: a supervised writer (desktop app) may respawn — if the fork returns, close it at the source.',
      );
      return 0;
    }
    const managed = await adoptSession(m, t.dir, uuid, name);
    console.log(
      `adopted ${uuid.slice(0, 8)} as '${managed}' (dir ${t.dir}) — resumed in ccmux tmux.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof LiveWritersError) {
      console.log(
        `adopt: ${uuid.slice(0, 8)} is LIVE — ${e.writers.map(describeWriter).join(', ')}.`,
      );
      console.log('a second resume would fork the conversation. choose explicitly:');
      console.log(
        `  ccmux adopt claude ${uuid} --fork      # safe: copy under a new uuid, original untouched`,
      );
      console.log(
        `  ccmux adopt claude ${uuid} --takeover  # kill the writer(s), then adopt the original`,
      );
      return 1;
    }
    console.log(`adopt: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
