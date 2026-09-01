import { existsSync, readFileSync } from 'node:fs';
import { nativeTranscriptPath } from '../../../context/claude.ts';
import type { RuntimeInput } from '../../../runtime/input.ts';
import type { Session } from '../../../types.ts';
import { isRecord, str } from '../../normalize.ts';

function textsOf(entry: unknown): string[] {
  if (!isRecord(entry) || str(entry.type) !== 'user') return [];
  const message = isRecord(entry.message) ? entry.message : null;
  const content = message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!isRecord(item) || str(item.type) !== 'text') return [];
    const text = str(item.text);
    return text === null ? [] : [text];
  });
}

/**
 * Whether a turn whose dispatch was cut short actually reached the conversation.
 *
 * The phase file says `dispatching`, which means the process died between pushing the turn and
 * recording that it had. That question has exactly one honest answer, and it is not in our files:
 * it is whether the runtime's own transcript contains the turn. Asked against the transcript rather
 * than assumed either way, because both assumptions lose something — assuming delivered drops a
 * message nobody sent, assuming undelivered sends a second copy of one already answered.
 *
 * Bounded in time as well as by text: the same words sent twice an hour apart are two turns, and
 * matching on text alone would read the older one as a receipt for the newer. The bound comes from
 * the record when it carries one and from the mailbox file's own timestamp when it does not — a
 * record written before that field existed still knows when it was written.
 */
export function nativeInputDelivered(
  session: Session,
  input: RuntimeInput,
  dispatchedAt: string,
): boolean {
  let path: string;
  try {
    path = nativeTranscriptPath(session);
  } catch {
    return false;
  }
  // Absent is "not delivered", not "unknown": a conversation the runtime never wrote cannot hold
  // a turn it never received.
  if (!existsSync(path)) return false;
  // Every line since the dispatch, not a fixed tail: a turn that was delivered and then produced
  // hundreds of tool lines before the crash would have scrolled out of any window measured in
  // lines, and been judged undelivered — which sends it a second time.
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const at = isRecord(parsed) ? str(parsed.timestamp) : null;
    if (at === null || at < dispatchedAt) continue;
    if (textsOf(parsed).includes(input.text)) return true;
  }
  return false;
}
