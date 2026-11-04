import { lstat, realpath } from 'node:fs/promises';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { uuidV7Time } from '../agent/codex/rolloutFiles.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { fileIdentity, scan, scanCompressed } from './contentSnapshot.ts';
import {
  type ExternalMessageAuthorship,
  type ExternalMessageReadSchema,
  type ExternalMessageResult,
  ExternalMessageResultSchema,
  EXTERNAL_MESSAGE_LIMITS as limits,
} from './messageSchema.ts';
import { authorizeExternalRead, openExternalPath } from './source.ts';
import { type CodexSegment, locateCodexSegments, validateExternalPath } from './storage.ts';

/**
 * Codex records who started a turn as `task_started.turn_attribution.turn_trigger`, written by the
 * client that started it. These triggers are a person acting in the Desktop client or on a phone.
 * `queue` is NOT among them: a letter an agent sends to a busy thread is queued too, and opens a
 * turn with the same trigger (observed in real histories).
 */
const PERSON_TRIGGERS = new Set(['composer', 'edit_user_message', 'remote_android', 'remote_ios']);
/** Turns started by an agent, an automation or the client itself. */
const NON_PERSON_TRIGGERS = new Set([
  'app_tool_send_message',
  'automation_heartbeat_scheduled',
  'goal',
  'app_update_resume',
  'resume_interrupted_task',
]);

/** The attribution names the turn, so it speaks only for the input that opened it. */
export function attributeAuthorship(
  trigger: string | null,
  position: 'turn-opening' | 'mid-turn',
): ExternalMessageAuthorship {
  if (position === 'mid-turn')
    return {
      verdict: 'unverifiable',
      trigger,
      position,
      reason: 'input added to a running turn carries no attribution of its own',
    };
  if (trigger === null)
    return {
      verdict: 'unverifiable',
      trigger,
      position,
      reason: 'the turn has no recorded trigger',
    };
  if (PERSON_TRIGGERS.has(trigger))
    return { verdict: 'person', trigger, position, reason: 'a person started the turn it opened' };
  if (NON_PERSON_TRIGGERS.has(trigger))
    return {
      verdict: 'not-person',
      trigger,
      position,
      reason: 'an agent, an automation or the client started the turn',
    };
  return {
    verdict: 'unverifiable',
    trigger,
    position,
    reason: 'the turn trigger does not identify who submitted the input',
  };
}

const PartSchema = z.object({ type: z.string(), text: z.string().optional() });
const ItemRecordSchema = z.object({
  timestamp: z.string().optional(),
  type: z.literal('event_msg'),
  payload: z.object({
    type: z.literal('item_completed'),
    thread_id: z.string(),
    turn_id: z.string(),
    item: z.object({
      type: z.string(),
      id: z.string(),
      client_id: z.string().optional(),
      content: z.array(PartSchema).optional(),
    }),
  }),
});
const TurnStartSchema = z.object({
  type: z.literal('event_msg'),
  payload: z.object({
    type: z.literal('task_started'),
    turn_id: z.string(),
    turn_attribution: z.object({ turn_trigger: z.string().max(64).optional() }).optional(),
  }),
});

const SessionMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({ id: z.string() }),
});

const TURN_ID = /"turn_id":"([^"]{1,128})"/;
const parse = (line: Buffer): unknown => {
  try {
    return JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
};
const isoOrNull = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

type Found = {
  id: string;
  clientId: string | null;
  turnId: string;
  recordedAt: string | null;
  text: string;
  images: number;
  textBytes: number;
  foreignParts: boolean;
  authorship: ExternalMessageAuthorship;
};

/**
 * The file a message was written to. A UUIDv7 message id carries its creation time, and each file
 * of a split history starts at a known time, so the message is in the last file that started
 * before it. Null when there are several files and either side carries no time.
 */
export function segmentHolding(segments: CodexSegment[], messageId: string): CodexSegment | null {
  if (segments.length === 1) return segments[0] ?? null;
  const at = uuidV7Time(messageId);
  if (at === null || segments.some((segment) => segment.start === null)) return null;
  let holding: CodexSegment | null = null;
  for (const segment of segments) if ((segment.start ?? 0) <= at) holding = segment;
  return holding;
}

/** One pass over the fixed prefix of a Codex history, keeping only what the answer needs. */
function codexMessageScanner(threadId: string, messageId: string) {
  const needle = Buffer.from(messageId);
  const turns = new Map<string, string | null>();
  const turnsWithInput = new Set<string>();
  const state = {
    /** The first record must be the thread's own `session_meta`; for a compressed file this is the
     *  only place that can be checked. */
    metadata: 'unseen' as 'unseen' | 'thread' | 'other',
    itemsSeen: false,
    found: null as Found | null,
    ambiguous: false,
    notUserInput: false,
    oversizedMatch: false,
  };
  let line: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;
  let tail = Buffer.alloc(0);

  const record = (buffer: Buffer) => {
    if (state.metadata === 'unseen') {
      const meta = SessionMetaSchema.safeParse(parse(buffer));
      state.metadata = meta.success && meta.data.payload.id === threadId ? 'thread' : 'other';
      return;
    }
    if (buffer.includes('"task_started"')) {
      const start = TurnStartSchema.safeParse(parse(buffer));
      if (start.success && turns.size < limits.turns)
        turns.set(
          start.data.payload.turn_id,
          start.data.payload.turn_attribution?.turn_trigger ?? null,
        );
      return;
    }
    if (!buffer.includes('"item_completed"')) return;
    state.itemsSeen = true;
    const mentions = buffer.includes(needle);
    const userInput = buffer.includes('"UserMessage"');
    if (!mentions) {
      if (userInput) {
        // Only the position matters here; the turn id precedes the item, so the head is enough.
        const turn = TURN_ID.exec(buffer.subarray(0, 1024).toString('utf8'))?.[1];
        if (turn) turnsWithInput.add(turn);
      }
      return;
    }
    const parsed = ItemRecordSchema.safeParse(parse(buffer));
    if (!parsed.success) return;
    const { payload } = parsed.data;
    if (payload.item.id !== messageId) {
      if (payload.item.type === 'UserMessage') turnsWithInput.add(payload.turn_id);
      return;
    }
    if (payload.thread_id !== threadId) return;
    if (payload.item.type !== 'UserMessage') {
      state.notUserInput = true;
      return;
    }
    let text = '';
    let images = 0;
    let foreignParts = false;
    for (const part of payload.item.content ?? []) {
      if (part.type === 'text' && part.text !== undefined) text += part.text;
      else if (part.type === 'image' || part.type === 'local_image') images++;
      else foreignParts = true;
    }
    const position = turnsWithInput.has(payload.turn_id) ? 'mid-turn' : 'turn-opening';
    turnsWithInput.add(payload.turn_id);
    const candidate: Found = {
      id: payload.item.id,
      clientId: payload.item.client_id ?? null,
      turnId: payload.turn_id,
      recordedAt: isoOrNull(parsed.data.timestamp),
      text,
      images,
      textBytes: Buffer.byteLength(text),
      foreignParts,
      authorship: attributeAuthorship(turns.get(payload.turn_id) ?? null, position),
    };
    if (state.found === null) state.found = candidate;
    else if (state.found.text !== candidate.text || state.found.turnId !== candidate.turnId)
      state.ambiguous = true;
  };

  const consume = (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (oversized) {
        // Look for the id across the chunk boundary without keeping the record.
        if (Buffer.concat([tail, piece]).includes(needle)) state.oversizedMatch = true;
        tail = Buffer.from(piece.subarray(Math.max(0, piece.length - needle.length)));
      } else if (lineBytes + piece.length > limits.recordBytes) {
        oversized = true;
        const held = Buffer.concat([...line, piece]);
        if (held.includes(needle)) state.oversizedMatch = true;
        tail = Buffer.from(held.subarray(Math.max(0, held.length - needle.length)));
        line = [];
        lineBytes = 0;
      } else {
        line.push(Buffer.from(piece));
        lineBytes += piece.length;
      }
      if (end < 0) return;
      if (!oversized) record(Buffer.concat(line));
      line = [];
      lineBytes = 0;
      oversized = false;
      tail = Buffer.alloc(0);
      start = end + 1;
    }
  };
  return { consume, state };
}

/**
 * Resolve one exact native message of an external Codex thread: the whole text, the native identity
 * and what the history says about who submitted it. Read-only: no provider is contacted, no writer is
 * started, nothing is retained after the call. Only complete records of the prefix present at open
 * are read; a partial last record is not a message yet.
 */
export async function readExternalMessage(
  m: MachineConfig,
  input: z.output<typeof ExternalMessageReadSchema>,
  signal: AbortSignal,
): Promise<ExternalMessageResult> {
  authorizeExternalRead(m, input.target);
  signal.throwIfAborted();
  const result: ExternalMessageResult = {
    target: input.target,
    messageId: input.messageId,
    outcome: 'history-absent',
    revision: null,
    observedAt: new Date().toISOString(),
    message: null,
  };
  if (input.target.provider !== 'codex') return { ...result, outcome: 'unsupported' };
  try {
    const configuredRoot = m.codexSessionsDir;
    if (!configuredRoot) return result;
    const root = await realpath(configuredRoot);
    const segments = await locateCodexSegments(root, input.target.threadId, signal);
    if (segments === null) return result;
    const segment = segmentHolding(segments, input.messageId);
    // An unplaceable file of a split history cannot be chosen; that is not a missing message.
    if (segment === null) return { ...result, outcome: 'unsupported' };
    const source = await openExternalPath(root, segment.path, input.target, segment.compressed);
    if (source === 'changed') return { ...result, outcome: 'unavailable' };
    const { file, stat, path } = source;
    try {
      const scanner = codexMessageScanner(input.target.threadId, input.messageId);
      let revision: string | null;
      if (segment.compressed) {
        revision = await scanCompressed(file, limits.sourceBytes, signal, scanner.consume);
        if (revision === null) return { ...result, outcome: 'too-large' };
      } else {
        if (stat.size > limits.sourceBytes)
          throw new AppError('RESOURCE_EXHAUSTED', {
            message: 'External history source exceeds the read budget',
            status: 413,
          });
        revision = await scan(file, stat.size, signal, scanner.consume);
        if (revision === null) return { ...result, outcome: 'unavailable' };
      }
      await validateExternalPath(root, path);
      authorizeExternalRead(m, input.target);
      if (fileIdentity(await lstat(path), path) !== fileIdentity(stat, path))
        return { ...result, outcome: 'unavailable' };
      const { state } = scanner;
      if (state.metadata !== 'thread') return { ...result, outcome: 'unavailable' };
      const read = { ...result, revision };
      if (state.ambiguous) return { ...read, outcome: 'ambiguous' };
      if (state.oversizedMatch) return { ...read, outcome: 'too-large' };
      const found = state.found;
      if (found === null) {
        if (state.notUserInput) return { ...read, outcome: 'not-user-input' };
        return { ...read, outcome: state.itemsSeen ? 'not-found' : 'unsupported' };
      }
      if (found.foreignParts) return { ...read, outcome: 'unsupported' };
      if (found.textBytes > limits.textBytes) return { ...read, outcome: 'too-large' };
      return ExternalMessageResultSchema.parse({
        ...read,
        outcome: 'resolved',
        message: {
          id: found.id,
          clientId: found.clientId,
          turnId: found.turnId,
          recordedAt: found.recordedAt,
          text: found.text,
          images: found.images,
          authorship: found.authorship,
        },
      });
    } finally {
      await file.close();
    }
  } catch (error) {
    if (signal.aborted || error instanceof AppError) throw error;
    log.warn({ msg: 'external message read unavailable', reason: String(error) });
    return { ...result, outcome: 'unavailable' };
  }
}
