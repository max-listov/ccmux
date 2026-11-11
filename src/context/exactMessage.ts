import { existsSync } from 'node:fs';
import { getProvider, providerFor } from '../agent/index.ts';
import { selfAddress } from '../fleet/address.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../types.ts';
import { fileLines } from './corpusSearch.ts';
import { EXACT_MESSAGE_LIMITS, type ExactMessageResult } from './exactMessageSchema.ts';
import { senderJudge } from './messageSender.ts';

/**
 * One message of a managed session, whole, by the id another system quotes it by.
 *
 * An agent that reports "the person said this" names the record it saw in its own history — the
 * provider's record id — while a window read names a message by that id and the part of the record
 * it is. Both are accepted. The message is returned whole or not at all, with who sent it: a
 * consumer that acts on a person's words needs the exact words and that verdict from one read.
 */
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
