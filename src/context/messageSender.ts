import { loadLedger } from '../chat/ledger.ts';
import { keysDigest, sentKeysOf } from '../session/sentKeys.ts';
import type { MachineConfig, TranscriptMessage } from '../types.ts';
import { isHarnessText } from './corpusSearch.ts';
import type { MessageSender } from './messageSenderSchema.ts';

/**
 * Who put a message into the user's side of a managed session's conversation.
 *
 * A provider records everything that enters a conversation from outside the model as a user
 * message: what a person typed, a letter another session sent, a hook's output, the notice that a
 * background task ended. A consumer that acts on a person's words has to know which it is, and the
 * owner of the history is the one that can say: the letters are in ccmux's own ledger, the keys
 * ccmux typed are in its own log, and the harness's forms are the forms this parser already reads.
 *
 * The verdict is about who SENT the message, not who wrote its words — pasted text is sent by the
 * one who pasted it.
 */
/** A hook's return, wrapped by the harness around whatever the hook printed — a letter included. */
const HOOK_FEEDBACK = /^\s*Stop hook feedback:\s*/;
const LETTER = /^\[chat from [^\]]*?· id: ([0-9a-f-]{36})\b/;
const LETTER_TAG = /^\[chat from /;
const ROUTED = /^\[(?:application )?input via /;
const ROUTED_ID = /^\[[^\]]*?· id: ([0-9a-f-]{36})\b/;

/** How long before a message its keys may have been sent: typing, then the turn that takes it. */
const KEYS_BEFORE_MS = 10 * 60 * 1000;
/** The provider stamps a message when it records it, a moment after the keys. */
const KEYS_AFTER_MS = 5_000;

export type SenderJudge = (
  message: Pick<TranscriptMessage, 'role' | 'kind' | 'text' | 'createdAt'>,
) => MessageSender | null;

/**
 * The judge of one session's messages. What it reads — the ledger, the log of sent keys — is read
 * once, on the first message that needs it.
 *
 * `textLimit` is the length the messages were read cut at. A cut text has lost the id a letter
 * carries and no longer has the digest of what was typed, so it is never called a person's: the
 * verdict says it could not be judged, and the whole message is one read away.
 */
export function senderJudge(m: MachineConfig, session: string, textLimit?: number): SenderJudge {
  const cut = (text: string): boolean => textLimit !== undefined && text.length > textLimit;
  const notJudged: MessageSender = {
    verdict: 'unverifiable',
    reason: 'the text was read cut, which hides what tells senders apart: read it whole by its id',
  };
  let letters: Set<string> | null = null;
  let keys: ReturnType<typeof sentKeysOf> | null = null;
  const inLedger = (id: string | undefined): boolean => {
    if (id === undefined) return false;
    letters ??= new Set(loadLedger(m).flatMap((slot) => (slot === null ? [] : [slot.id])));
    return letters.has(id);
  };
  return (message) => {
    // Only what is recorded as the user's own message has a sender to ask about.
    if (message.role !== 'user' || message.kind !== 'message') return null;
    const text = message.text ?? '';
    const hooked = HOOK_FEEDBACK.test(text);
    const inner = text.replace(HOOK_FEEDBACK, '');
    if (LETTER_TAG.test(inner)) {
      const id = LETTER.exec(inner)?.[1];
      if (id === undefined && cut(text)) return notJudged;
      return inLedger(id)
        ? { verdict: 'session-letter', reason: `delivered by ccmux: ledger message ${id}` }
        : {
            verdict: 'unverifiable',
            reason: "reads as a delivered letter, but this machine's ledger holds no such message",
          };
    }
    if (ROUTED.test(inner)) {
      const id = ROUTED_ID.exec(inner)?.[1];
      if (id === undefined && cut(text)) return notJudged;
      return inLedger(id)
        ? {
            verdict: 'routed-input',
            reason: `input through a router or application, delivered by ccmux: ledger message ${id}`,
          }
        : {
            verdict: 'unverifiable',
            reason: "reads as routed input, but this machine's ledger holds no such message",
          };
    }
    if (hooked) return { verdict: 'harness', reason: "a hook's return, written by the harness" };
    if (isHarnessText(text))
      return { verdict: 'harness', reason: 'a record the harness writes on the user side' };
    if (cut(text)) return notJudged;
    const at = message.createdAt === null ? Number.NaN : Date.parse(message.createdAt);
    if (Number.isFinite(at)) {
      keys ??= sentKeysOf(m, session);
      const digest = keysDigest(text);
      const typed = keys.findLast(
        (row) =>
          row.digest === digest && row.at >= at - KEYS_BEFORE_MS && row.at <= at + KEYS_AFTER_MS,
      );
      if (typed !== undefined)
        return {
          verdict: 'ccmux-keys',
          reason: `typed into the pane by ccmux send, run by ${typed.by}`,
        };
    }
    return {
      verdict: 'person',
      reason:
        "entered in the provider's client and not typed by ccmux; keys sent to the pane outside ccmux are not recorded and would read the same",
    };
  };
}

/** One judge per session of a machine, made when its first message is asked about. */
export type ConversationSenders = (ofSession: string | null) => SenderJudge;

/**
 * The judges of every conversation on this machine, for a reader that walks many of them.
 *
 * A conversation no session reads has no pane ccmux could have typed into, so only the ledger and
 * the harness's own forms can speak about it; the log of sent keys is asked for no session.
 */
export function conversationSenders(m: MachineConfig, textLimit?: number): ConversationSenders {
  const judges = new Map<string, SenderJudge>();
  return (ofSession) => {
    const session = ofSession ?? '';
    let judge = judges.get(session);
    if (judge === undefined) {
      judge = senderJudge(m, session, textLimit);
      judges.set(session, judge);
    }
    return judge;
  };
}
