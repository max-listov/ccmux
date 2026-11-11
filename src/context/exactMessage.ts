import { existsSync } from 'node:fs';
import { z } from 'zod';
import { getProvider, providerFor } from '../agent/index.ts';
import { selfAddress } from '../fleet/address.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../types.ts';
import { fileLines } from './corpusSearch.ts';
import { MessageSenderSchema, senderJudge } from './messageSender.ts';

/**
 * One message of a managed session, whole, by the id another system quotes it by.
 *
 * An agent that reports "the person said this" names the record it saw in its own history — the
 * provider's record id — while a window read names a message by that id and the part of the record
 * it is. Both are accepted. The message is returned whole or not at all, with who sent it: a
 * consumer that acts on a person's words needs the exact words and that verdict from one read.
 */
export const EXACT_MESSAGE_LIMITS = {
  /** The message text is returned whole or not at all; past this it is `too-large`. */
  textBytes: 256 * 1024,
};

/**
 * `resolved`: the exact message, whole. `not-found`: the conversation has no record with that id.
 * `not-user-input`: the id names something that is not a user message — the agent's answer, a tool
 * call. `ambiguous`: the record holds several user messages; name one by its full id. `too-large`:
 * the text exceeds the bound and is not returned cut. `unsupported`: this session's runtime keeps
 * no history file to read a record from. `unavailable`: the history could not be read.
 */
export const ExactMessageOutcomeSchema = z.enum([
  'resolved',
  'not-found',
  'not-user-input',
  'ambiguous',
  'too-large',
  'unsupported',
  'unavailable',
]);

export const ExactMessageResultSchema = z
  .object({
    target: z.string().min(1),
    messageId: z.string().min(1),
    outcome: ExactMessageOutcomeSchema,
    observedAt: z.iso.datetime(),
    message: z
      .object({
        /** The id a window read gives this message: the record's id and the part of it. */
        id: z.string().min(1),
        seq: z.int().positive(),
        recordedAt: z.string().nullable(),
        /** The whole text, nothing cut and nothing added. */
        text: z.string(),
        sender: MessageSenderSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ExactMessageResult = z.infer<typeof ExactMessageResultSchema>;

/** Characters a message is parsed up to: past the byte bound, so a cut text is seen as too large. */
const PARSE_CHARS = EXACT_MESSAGE_LIMITS.textBytes + 1;

export async function readExactMessage(
  m: MachineConfig,
  session: Session,
  messageId: string,
): Promise<ExactMessageResult> {
  const answer = (
    outcome: ExactMessageResult['outcome'],
    message: ExactMessageResult['message'] = null,
  ): ExactMessageResult => ({
    target: selfAddress(m, session.name),
    messageId,
    outcome,
    observedAt: new Date().toISOString(),
    message,
  });
  const path = providerFor(session).historyFile(session, m);
  if (path === null) return answer('unsupported');
  if (!existsSync(path)) return answer('unavailable');
  const parser = getProvider(session.agent === 'codex' ? 'codex' : 'claude');
  const found: TranscriptMessage[] = [];
  try {
    for await (const { lines, base } of fileLines({ path, compressed: false })) {
      // The record's id is in the line that holds it: lines without it are not parsed at all.
      const record = messageId.split(':')[0] as string;
      if (!lines.some((line) => line.includes(record))) continue;
      for (const message of parser.parse(lines, base, PARSE_CHARS, undefined, base))
        if (message.id === messageId || message.id.startsWith(`${messageId}:`)) found.push(message);
    }
  } catch {
    return answer('unavailable');
  }
  if (found.length === 0) return answer('not-found');
  const said = found.filter((message) => message.role === 'user' && message.kind === 'message');
  if (said.length === 0) return answer('not-user-input');
  if (said.length > 1) return answer('ambiguous');
  const message = said[0] as TranscriptMessage;
  const text = message.text ?? '';
  if (Buffer.byteLength(text, 'utf8') > EXACT_MESSAGE_LIMITS.textBytes) return answer('too-large');
  const sender = senderJudge(m, session.name)(message);
  if (sender === null) return answer('not-user-input');
  return answer('resolved', {
    id: message.id,
    seq: message.seq,
    recordedAt: message.createdAt,
    text,
    sender,
  });
}
