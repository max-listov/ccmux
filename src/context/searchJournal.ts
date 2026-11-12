import { existsSync } from 'node:fs';
import { z } from 'zod';
import { searchJournalPath } from '../config/paths.ts';
import { externalSessionKey } from '../external/keys.ts';
import type { MachineConfig } from '../types.ts';
import { appendJsonl, readJsonl, rotateBySize, UNREADABLE } from '../util/jsonl.ts';
import { log } from '../util/log.ts';
import { CorpusSearchJsonSchema } from './corpusSearchSchema.ts';
import type { SearchFrame } from './searchFrames.ts';

/**
 * What was asked of `search` on this machine, by whom, and what came of it.
 *
 * One line per search a caller asked HERE — on the command line or through the control API. A
 * machine that another one asks as part of ITS fleet search writes nothing: the search belongs to the
 * machine where it was asked, and that machine's line already says how each machine it asked
 * answered. So the fleet's report is the sum of the machines' journals, with nothing counted twice.
 *
 * The pattern is kept as it was written. The journal is state of the machine it describes, read by
 * `search --report`; it is never sent anywhere except to that report.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP = 2;

/** Which of the questions `search` answers was asked. */
export const SearchModeSchema = z.enum(['lines', 'map', 'outline', 'receipts']);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const SearchJournalEntrySchema = z.strictObject({
  at: z.iso.datetime(),
  /** How the search was asked: a command, or a control API call. */
  via: z.enum(['cli', 'control']),
  /** Who asked: a session address, a control principal, or null when nothing named the caller. */
  caller: z.string().min(1).nullable(),
  /** The directory a command was run in; a control call has none. */
  dir: z.string().min(1).nullable(),
  mode: SearchModeSchema,
  query: CorpusSearchJsonSchema.shape.query,
  /** How each machine that was asked answered. */
  machines: CorpusSearchJsonSchema.shape.machines,
  total: z.int().nonnegative(),
  elapsedMs: z.int().nonnegative(),
});
export type SearchJournalEntry = z.infer<typeof SearchJournalEntrySchema>;

type Answer = Pick<SearchJournalEntry, 'query' | 'machines' | 'total'>;

/** The question an answer is to: its query says all of it except the map, which only a command draws. */
export function searchMode(query: Answer['query'], map: boolean): SearchMode {
  if (query.receipts === true) return 'receipts';
  if (query.pattern === null) return 'outline';
  return map ? 'map' : 'lines';
}

/**
 * Who runs this command, as far as its environment says: a managed session by its name, a Claude
 * or Codex conversation by the address `transcript` opens, or nobody — a person at a terminal, a
 * script. The environment is a claim, not a proof; the journal records it as the caller's own word.
 */
export function commandCaller(
  machine: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.CCMUX_SESSION) return `${machine}:${env.CCMUX_SESSION}`;
  if (env.CLAUDE_CODE_SESSION_ID)
    return externalSessionKey('claude', machine, env.CLAUDE_CODE_SESSION_ID);
  if (env.CODEX_THREAD_ID) return externalSessionKey('codex', machine, env.CODEX_THREAD_ID);
  return null;
}

export interface JournalInput {
  via: SearchJournalEntry['via'];
  caller: string | null;
  dir: string | null;
  map: boolean;
  answer: Answer;
  startedAt: number;
  now?: number;
}

export function journalEntry(input: JournalInput): SearchJournalEntry {
  const now = input.now ?? Date.now();
  return {
    at: new Date(now).toISOString(),
    via: input.via,
    caller: input.caller,
    dir: input.dir,
    mode: searchMode(input.answer.query, input.map),
    query: input.answer.query,
    machines: input.answer.machines,
    total: input.answer.total,
    elapsedMs: Math.max(0, Math.round(now - input.startedAt)),
  };
}

/**
 * Write one line. The search has already answered its caller, and a line the journal could not take
 * must not turn that answer into a failure — so the loss is said in the log, where `doctor` and a
 * person reading it find it, and the caller keeps the answer.
 */
export function journalSearch(m: Pick<MachineConfig, 'stateDir'>, entry: SearchJournalEntry): void {
  const path = searchJournalPath(m);
  try {
    rotateBySize(path, MAX_BYTES, KEEP);
    appendJsonl(path, entry);
  } catch (error) {
    log.warn({ msg: 'search journal line not written', path, error: String(error) });
  }
}

/** A line that is not JSON, or not a journal line, keeps its place so the report can count it. */
const JOURNAL = {
  label: 'search-journal',
  badLine: 'hole',
  decode: (raw: unknown): SearchJournalEntry | typeof UNREADABLE => {
    if (raw === UNREADABLE) return UNREADABLE;
    return SearchJournalEntrySchema.safeParse(raw).data ?? UNREADABLE;
  },
} as const;

export interface JournalRead {
  entries: SearchJournalEntry[];
  /** Lines in the period's files that are not journal lines: torn, or written by another build. */
  unreadable: number;
}

/** The searches asked between `since` and `until` (inclusive), oldest first, across rotations. */
export function readSearchJournal(
  m: Pick<MachineConfig, 'stateDir'>,
  since: number,
  until: number | null,
): JournalRead {
  const path = searchJournalPath(m);
  const files: string[] = [];
  for (let generation = KEEP; generation >= 1; generation--)
    if (existsSync(`${path}.${generation}`)) files.push(`${path}.${generation}`);
  if (existsSync(path)) files.push(path);
  const entries: SearchJournalEntry[] = [];
  let unreadable = 0;
  for (const file of files) {
    for (const row of readJsonl(file, JOURNAL)) {
      if (row === UNREADABLE) {
        unreadable++;
        continue;
      }
      const at = Date.parse(row.at);
      if (at < since || (until !== null && at > until)) continue;
      entries.push(row);
    }
  }
  return { entries, unreadable };
}

/**
 * A control search's frames, passed through as they come, and its line written when the last one
 * says what was searched. A stream its reader left before that frame was not answered, so it is not
 * a search that happened: nothing is written for it.
 */
export async function* journaledFrames(
  frames: AsyncIterable<SearchFrame>,
  record: (end: Extract<SearchFrame, { frame: 'end' }>) => void,
): AsyncGenerator<SearchFrame> {
  for await (const frame of frames) {
    if (frame.frame === 'end') record(frame);
    yield frame;
  }
}
