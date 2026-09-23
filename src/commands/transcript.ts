import { existsSync, readFileSync } from 'node:fs';
import { readImage } from '../agent/claude/transcript.ts';
import { providerFor } from '../agent/index.ts';
import { codexAppThreadId, isCodexAppToken } from '../chat/identity.ts';
import { transcriptJson, transcriptReadJson } from '../context/transcriptJson.ts';
import type { TranscriptWindowOptions } from '../context/transcriptWindow.ts';
import { readTranscriptWindow } from '../context/transcriptWindow.ts';
import { parseExternalSessionKey } from '../external/keys.ts';
import { readExternalTranscript } from '../external/transcript.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import type { TranscriptMessage } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { parseFlags, UsageError } from './flags.ts';
import { usageLine } from './help.ts';
import { runSearch, type SearchArgs } from './transcriptSearch.ts';

/** Newest assistant TEXT block (skipping tool calls/results and thinking) — the agent's answer. */
export function lastAssistantText(messages: TranscriptMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && msg.kind === 'message' && msg.text) return msg.text;
  }
  return null;
}

const LAST_MESSAGE_WINDOW = 200; // enough lines back to find the last answer without reading the file

// Full text, not the display clip: `--last-message` exists precisely to get the WHOLE report
// (`list --json` already carries lastMessage, but clipped to 280 chars).
const FULL_TEXT_LIMIT = 1_000_000;

export interface Opts {
  /** The session, App thread or external key asked about. */
  name: string;
  /** The arguments without the address — what a peer is forwarded. */
  flagArgs: string[];
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
  /** A search instead of a window: everything the command line said about it. */
  search?: Omit<SearchArgs, 'limit' | 'cursor' | 'before' | 'tail' | 'agent'>;
  /** Whether `--tail` was written. Its default sizes a window; a search is not narrowed by it. */
  tailGiven: boolean;
}

/** A window is one answer and has to fit in one, so a larger request is served at this size — the
 *  documented cap, not an error. A search reads any range in batches and is not capped. */
const WINDOW_MAX_LINES = 1000;

const capped = (value: number | undefined, cap: number): number | undefined =>
  value === undefined ? undefined : Math.min(value, cap);

export function parseOpts(args: string[]): Opts {
  const flags = parseFlags('transcript', args, [1, 1]);
  const grep = flags.str('grep');
  const given = flags.int('tail');
  const caseMode: SearchArgs['caseMode'] = flags.bool('ignore-case')
    ? 'ignore'
    : flags.bool('case-sensitive')
      ? 'sensitive'
      : 'smart';
  const opts: Opts = {
    name: flags.positionals[0] as string,
    flagArgs: flags.flagArgs,
    json: flags.bool('json'),
    lastMessage: flags.bool('last-message'),
    tail: grep === undefined ? Math.min(given ?? 200, WINDOW_MAX_LINES) : (given ?? 200),
    tailGiven: given !== undefined,
  };
  const optional = {
    image: flags.str('image'),
    agent: flags.str('agent'),
    cursor: flags.int('cursor'),
    before: flags.int('before'),
    limit: capped(flags.int('limit'), WINDOW_MAX_LINES),
    textLimit: capped(flags.int('text-limit'), FULL_TEXT_LIMIT),
  };
  for (const [key, value] of Object.entries(optional))
    if (value !== undefined && value !== '') Object.assign(opts, { [key]: value });
  if (grep !== undefined)
    opts.search = {
      grep,
      fixed: flags.bool('fixed-strings'),
      caseMode,
      roles: flags.list('role'),
      kinds: flags.list('kind'),
    };
  return opts;
}

export async function cmdTranscript(args: string[]): Promise<number> {
  const o = parseOpts(args);
  let name = o.name;
  if (!o.json && !o.lastMessage && o.image === undefined && o.search === undefined)
    throw new UsageError(
      `choose what to read: --json, --last-message, --grep or --image\n${usageLine('transcript')}`,
    );
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
    o.flagArgs,
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
      const rc = external ? name : `${m.rcPrefix}:${name}`;
      if (o.search !== undefined) {
        let dir = '';
        return await runSearch(
          async (window) => {
            const found = await readExternalTranscript(m, target, window);
            dir = found.dir;
            return found.read;
          },
          searchArgs(o),
          {
            json: o.json,
            target: rc,
            header: (read) => transcriptReadJson(m, { name, uuid: threadId, dir }, read, rc),
          },
        );
      }
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
          JSON.stringify(transcriptReadJson(m, { name, uuid: threadId, dir }, read, rc)),
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

  if (o.search !== undefined)
    return runSearch((window) => readTranscriptWindow(m, s, window), searchArgs(o), {
      json: o.json,
      target: `${m.rcPrefix}:${s.name}`,
      header: (read) => transcriptReadJson(m, s, read),
    });

  // `--last-message`: the agent's final answer as plain text — the "take the report" gesture, so an
  // orchestrator doesn't have to pull a window of JSON and dig the last assistant block out of it.
  if (o.lastMessage) {
    const read = await readTranscriptWindow(m, s, {
      tail: LAST_MESSAGE_WINDOW,
      textLimit: FULL_TEXT_LIMIT,
    });
    const last = lastAssistantText(read.messages);
    if (last === null) {
      console.error(`${name}: no assistant message yet`);
      return 1;
    }
    console.log(last);
    return 0;
  }
  const readOpts: TranscriptWindowOptions = { tail: o.tail };
  if (o.cursor !== undefined) readOpts.cursor = o.cursor;
  if (o.before !== undefined) readOpts.before = o.before;
  if (o.limit !== undefined) readOpts.limit = o.limit;
  if (o.textLimit !== undefined) readOpts.textLimit = o.textLimit;
  if (o.agent !== undefined) readOpts.agent = o.agent;
  await printLine(JSON.stringify(await transcriptJson(m, s, readOpts)));
  return 0;
}

function searchArgs(o: Opts): SearchArgs {
  const args: SearchArgs = { ...(o.search as NonNullable<Opts['search']>) };
  if (o.limit !== undefined) args.limit = o.limit;
  if (o.cursor !== undefined) args.cursor = o.cursor;
  if (o.before !== undefined) args.before = o.before;
  if (o.tailGiven) args.tail = o.tail;
  if (o.agent !== undefined) args.agent = o.agent;
  return args;
}
