import { existsSync, readFileSync } from 'node:fs';
import { readImage } from '../agent/claude/transcript.ts';
import { providerFor, readTranscript } from '../agent/index.ts';
import type { TranscriptRead } from '../agent/transcriptRead.ts';
import { codexAppThreadId, isCodexAppToken } from '../chat/identity.ts';
import { rcName } from '../config/machine.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import { parseExternalSessionKey } from '../external/keys.ts';
import { readExternalTranscript } from '../external/transcript.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import type { MachineConfig, Session, TranscriptJson, TranscriptMessage } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';

/** Newest assistant TEXT block (skipping tool calls/results and thinking) — the agent's answer. */
export function lastAssistantText(messages: TranscriptMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && msg.kind === 'message' && msg.text) return msg.text;
  }
  return null;
}

const LAST_MESSAGE_WINDOW = 200; // enough lines back to find the last answer without reading the file

const USAGE =
  'usage: ccmux transcript <name|app/UUID|machine:app/UUID|external:provider:machine#UUID> --json [--tail N] [--cursor LINE] [--before LINE --limit N] [--text-limit CHARS] [--agent ID]\n' +
  "       ccmux transcript <name> --last-message        (just the agent's final answer, as text)\n" +
  '       ccmux transcript <name> --image <address>     (one image, as a data URL)';

// Full text, not the display clip: `--last-message` exists precisely to get the WHOLE report
// (`list --json` already carries lastMessage, but clipped to 280 chars).
const FULL_TEXT_LIMIT = 1_000_000;

export interface Opts {
  json: boolean;
  lastMessage: boolean;
  /** The address a message's `image` carried; asking for the picture, not the record of it. */
  image?: string;
  tail: number;
  cursor?: number;
  before?: number;
  limit?: number;
  /** Per-message text budget; the default clip is sized for a listing, not for a report. */
  textLimit?: number;
  /** A spawned agent's transcript, by the id the session's `Agent` call carries. */
  agent?: string;
}

export function parseOpts(args: string[]): Opts {
  let json = false;
  let lastMessage = false;
  let image: string | undefined;
  let tail = 200;
  let cursor: number | undefined;
  let before: number | undefined;
  let limit: number | undefined;
  let textLimit: number | undefined;
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--last-message') lastMessage = true;
    else if (a === '--image') image = args[++i];
    else if (a === '--agent') agent = args[++i];
    else if (a === '--text-limit') {
      const n = Number.parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n)) textLimit = n;
    } else if (a === '--tail') {
      const n = Number.parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n)) tail = n;
    } else if (a === '--cursor') {
      const n = Number.parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n)) cursor = n;
    } else if (a === '--before') {
      const n = Number.parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n)) before = n;
    } else if (a === '--limit') {
      const n = Number.parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n)) limit = n;
    } else if (a !== undefined && /^\d+$/.test(a)) {
      tail = Number.parseInt(a, 10);
    }
  }
  tail = Math.min(Math.max(tail, 1), 1000);
  if (limit !== undefined) limit = Math.min(Math.max(limit, 1), 1000);
  const opts: Opts = { json, lastMessage, tail };
  if (image !== undefined && image !== '') opts.image = image;
  if (cursor !== undefined) opts.cursor = cursor;
  if (before !== undefined) opts.before = before;
  if (limit !== undefined) opts.limit = limit;
  if (textLimit !== undefined) opts.textLimit = Math.min(Math.max(textLimit, 1), FULL_TEXT_LIMIT);
  if (agent !== undefined && agent !== '') opts.agent = agent;
  return opts;
}

export async function cmdTranscript(name: string | undefined, args: string[]): Promise<number> {
  if (!name) {
    console.log(USAGE);
    return 1;
  }
  const o = parseOpts(args);
  if (!o.json && !o.lastMessage && o.image === undefined) {
    console.log(USAGE);
    return 1;
  }
  let external: ReturnType<typeof parseExternalSessionKey> | undefined;
  try {
    if (name.startsWith('external:')) external = parseExternalSessionKey(name);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const fwd = await forwardIfRemote(
    external ? `${external.machine}:${external.threadId}` : name,
    'transcript',
    args,
    external ? { remoteTarget: name } : {},
  );
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  if (!external) name = session;
  if (external || isCodexAppToken(name)) {
    if (o.agent !== undefined) {
      console.error(`${name}: external agent transcripts are not supported`);
      return 1;
    }
    if (o.image !== undefined) {
      console.error(`${name}: external transcript images are not supported`);
      return 1;
    }
    try {
      const target =
        external ??
        ({ provider: 'codex', threadId: codexAppThreadId(name) } satisfies Parameters<
          typeof readExternalTranscript
        >[1]);
      const { threadId } = target;
      const window = o.lastMessage ? { tail: LAST_MESSAGE_WINDOW, textLimit: FULL_TEXT_LIMIT } : o;
      const { read, dir } = await readExternalTranscript(m, target, window);
      if (o.lastMessage) {
        const last = lastAssistantText(read.messages);
        if (!read.available || last === null) {
          console.error(`${name}: ${read.error ?? 'no assistant message yet'}`);
          return 1;
        }
        await printLine(last);
      } else {
        await printLine(
          JSON.stringify(
            transcriptReadJson(
              m,
              { name, uuid: threadId, dir },
              read,
              external ? name : `${m.rcPrefix}:${name}`,
            ),
          ),
        );
      }
      return read.available ? 0 : 1;
    } catch (error) {
      console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const s = findSession(loadSessions(m), name);
  if (!s) {
    console.log(`unknown session: ${name}`);
    return 1;
  }
  // `--image`: the picture itself, by the address the message carried. Kept off the message so a
  // listing stays cheap — `lastMessage` in `list --json` is read constantly and wants no pictures.
  if (o.image !== undefined) {
    const path = providerFor(s).historyFile(s, m);
    if (!path || !existsSync(path)) {
      console.error(`${name}: transcript file not found`);
      return 1;
    }
    const found = readImage(readFileSync(path, 'utf8').split('\n'), o.image);
    if ('unavailable' in found) {
      console.error(`${name}: image unavailable (${found.unavailable})`);
      return 1;
    }
    console.log(`data:${found.mediaType ?? 'application/octet-stream'};base64,${found.data}`);
    return 0;
  }

  // `--last-message`: the agent's final answer as plain text — the "take the report" gesture, so an
  // orchestrator doesn't have to pull a window of JSON and dig the last assistant block out of it.
  if (o.lastMessage) {
    const read = readTranscript(s, m, { tail: LAST_MESSAGE_WINDOW, textLimit: FULL_TEXT_LIMIT });
    const last = lastAssistantText(read.messages);
    if (last === null) {
      console.error(`${name}: no assistant message yet`);
      return 1;
    }
    console.log(last);
    return 0;
  }
  const readOpts: TranscriptWindow = { tail: o.tail };
  if (o.cursor !== undefined) readOpts.cursor = o.cursor;
  if (o.before !== undefined) readOpts.before = o.before;
  if (o.limit !== undefined) readOpts.limit = o.limit;
  if (o.textLimit !== undefined) readOpts.textLimit = o.textLimit;
  if (o.agent !== undefined) readOpts.agent = o.agent;
  await printLine(JSON.stringify(transcriptJson(m, s, readOpts)));
  return 0;
}

/** What a caller asks for: the newest `tail`, everything after a `cursor`, or a page `before` a
 *  line. The same three the command line accepts, because they are the same question. */
export interface TranscriptWindow {
  tail: number;
  cursor?: number;
  before?: number;
  limit?: number;
  textLimit?: number;
  agent?: string;
}

/**
 * One session's transcript window as the published answer.
 *
 * Built here for both the command and the control service, because two builders of the same answer
 * drift — and this one carries the cursor a consumer hands back, so a drift between them would be a
 * consumer paging through a slightly different conversation depending on how it asked.
 */
export function transcriptJson(
  m: MachineConfig,
  s: Session,
  window: TranscriptWindow,
): TranscriptJson {
  const read = readTranscript(s, m, window);
  return transcriptReadJson(m, s, read);
}

function transcriptReadJson(
  m: MachineConfig,
  s: Pick<Session, 'name' | 'uuid' | 'dir'>,
  read: TranscriptRead,
  rc = rcName(m, s.name),
): TranscriptJson {
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    session: { name: s.name, uuid: s.uuid, rc, dir: s.dir, machine: m.rcPrefix },
    source: {
      kind: read.available ? `${read.agent}-jsonl` : 'unavailable',
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
    stats: read.stats,
    messages: read.messages,
  };
}
