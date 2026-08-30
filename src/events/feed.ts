import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs';
import { dirname } from 'node:path';
import { eventsPath } from '../config/paths.ts';
import { SESSION_EVENT_VERSION, SessionEventSchema } from '../config/schema.ts';
import type { MachineConfig, Session, SessionEvent, SessionEventKind } from '../types.ts';

/**
 * The session event feed: an append-only record of what HAPPENED to the sessions on this machine.
 *
 * Why a file and not a callback. The turn-boundary hook runs INSIDE the agent's stop path — it is
 * what the agent waits on to finish a turn — so anything expensive there is a delay every session
 * pays on every turn. An append is one syscall. Running a consumer's command there instead would put
 * somebody else's code on the critical path of every turn on the machine, where one hung process
 * stalls an agent; that is the trade this design exists to refuse.
 *
 * Why append-only. Two independent writers (the hook, and the daemon that watches panes) and any
 * number of readers, with no lock between them: `O_APPEND` writes of a single line are atomic, the
 * same property the chat ledger and the outbox already rely on here.
 *
 * Delivery is **at-least-once**, deliberately. A reader that reconnects with `--since` re-reads the
 * boundary instant, and a writer that cannot prove a previous write may repeat one. Every event
 * therefore carries `id`, and a consumer that acts on events is expected to drop ids it has seen.
 * Exactly-once would need coordination between writers that the hook cannot afford to wait for.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 2; // rotated generations: .1, .2
const FEED_NAME = 'events.jsonl';

/** Shift events.jsonl → .1 → .2 past the size cap. Best-effort: rotation must never cost an event,
 *  and must never throw inside a hook the agent is waiting on. */
function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
  } catch {
    return; // no file yet
  }
  try {
    rmSync(`${path}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {
        // that generation does not exist — fine
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // never crash a turn over housekeeping
  }
}

export interface EmitInput {
  event: SessionEventKind;
  durationMs?: number;
  interrupted?: boolean;
  detail?: string;
}

/** Build one event from a session. The clock and the RNG are parameters, so the record shape is
 *  testable without stubbing either. */
export function buildEvent(
  m: MachineConfig,
  s: Session,
  input: EmitInput,
  id: string,
  nowIso: string,
): SessionEvent {
  return SessionEventSchema.parse({
    v: SESSION_EVENT_VERSION,
    id,
    ts: nowIso,
    machine: m.rcPrefix,
    session: s.name,
    agent: s.agent,
    threadId: s.uuid,
    event: input.event,
    ...(input.durationMs === undefined ? {} : { durationMs: Math.round(input.durationMs) }),
    ...(input.interrupted === undefined ? {} : { interrupted: input.interrupted }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
}

/**
 * Append one event. Fail-open by construction: every path swallows its error, because both callers
 * are places where failure must not propagate — a hook the agent is waiting on, and the daemon tick
 * that heals the fleet. A lost line is a lost notification; a thrown error is a stalled turn.
 */
export function appendEvent(m: MachineConfig, s: Session, input: EmitInput): SessionEvent | null {
  try {
    const event = buildEvent(m, s, input, randomUUID(), new Date().toISOString());
    const path = eventsPath(m);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(event)}\n`);
    return event;
  } catch {
    return null;
  }
}

/** Parse one line, or null. Lenient on purpose: a torn line from a crash, or a record from a newer
 *  build carrying a field this one does not know, costs that line and never the whole read. */
export function parseEvent(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    return SessionEventSchema.safeParse(JSON.parse(trimmed)).data ?? null;
  } catch {
    return null;
  }
}

/** Oldest generation first, so a read spans a rotation without reordering history. */
export function feedFiles(m: MachineConfig): string[] {
  const path = eventsPath(m);
  const files: string[] = [];
  for (let i = KEEP; i >= 1; i--) if (existsSync(`${path}.${i}`)) files.push(`${path}.${i}`);
  if (existsSync(path)) files.push(path);
  return files;
}

export interface ReadOptions {
  /** ISO instant; events at or after it are returned. The cursor is a TIME, not a byte offset,
   *  because an offset is meaningless the moment the feed rotates — and rotation is normal here, not
   *  an edge case. Re-reading the boundary instant is exactly why `id` exists. */
  since?: string;
  session?: string;
  limit?: number;
}

export function readEvents(m: MachineConfig, opts: ReadOptions = {}): SessionEvent[] {
  const sinceMs = opts.since === undefined ? null : Date.parse(opts.since);
  const out: SessionEvent[] = [];
  for (const file of feedFiles(m)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // rotated out from under us mid-read — later generations still carry what matters
    }
    for (const line of text.split('\n')) {
      const event = parseEvent(line);
      if (event === null) continue;
      if (opts.session !== undefined && event.session !== opts.session) continue;
      if (sinceMs !== null && Number.isFinite(sinceMs) && Date.parse(event.ts) < sinceMs) continue;
      out.push(event);
    }
  }
  return opts.limit === undefined ? out : out.slice(-opts.limit);
}

/**
 * Stream events as they are appended.
 *
 * Watch, not poll: the point of the feed is that a consumer learns of a turn boundary when it
 * happens rather than up to an interval later. A shrunken file means the feed rotated under us, so
 * the reader reopens at the start of the new generation instead of seeking past its end — the one
 * failure that would otherwise look exactly like "the fleet went quiet".
 */
export function followEvents(
  m: MachineConfig,
  onEvent: (event: SessionEvent) => void,
  opts: { since?: string; session?: string; signal?: AbortSignal } = {},
): () => void {
  const path = eventsPath(m);
  let offset = 0;
  let carry = '';

  // Everything already in the feed at or after the cursor, before watching begins — so a consumer
  // that reconnects does not have to choose between missing the gap and replaying all of history.
  const backlog: ReadOptions = {};
  if (opts.since !== undefined) backlog.since = opts.since;
  if (opts.session !== undefined) backlog.session = opts.session;
  if (opts.since !== undefined) for (const event of readEvents(m, backlog)) onEvent(event);
  try {
    offset = statSync(path).size;
  } catch {
    offset = 0; // no feed yet — start at the beginning of the one that will appear
  }

  const drain = (): void => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      offset = 0;
      carry = '';
      return; // gone for a moment (rotation) — pick it up when it is back
    }
    if (size < offset) {
      offset = 0; // rotated or truncated: the bytes we had live in a previous generation now
      carry = '';
    }
    if (size === offset) return;
    let chunk: string;
    try {
      chunk = readFileSync(path, 'utf8').slice(offset);
    } catch {
      return;
    }
    offset = size;
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() ?? ''; // a line may still be mid-write; hold it until its newline arrives
    for (const line of lines) {
      const event = parseEvent(line);
      if (event === null) continue;
      if (opts.session !== undefined && event.session !== opts.session) continue;
      onEvent(event);
    }
  };

  // Watched on the DIRECTORY, not the file: rename-based rotation replaces the inode, and a watcher
  // bound to the old one would keep watching a file nobody writes to any more.
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename === null || filename === FEED_NAME) drain();
    });
  } catch {
    watcher = null;
  }
  // A slow net under the watcher, not the primary path: fs events are not guaranteed on every
  // platform or filesystem, and a feed that silently stops streaming is indistinguishable, to a
  // consumer, from an idle fleet.
  const timer = setInterval(drain, 2_000);

  const stop = (): void => {
    clearInterval(timer);
    watcher?.close();
  };
  opts.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
