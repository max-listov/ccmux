import { z } from 'zod';
import type { ChatMessage } from '../types.ts';
import { preview } from '../util/preview.ts';
import { continuationRef } from './communicationAuthorizationSchema.ts';
import { targetLabel } from './identity.ts';

/*
 * What became of a letter, as its sender is told — when it is sent (`ccmux msg … --json`) and when
 * the sender looks back (`ccmux msg sent --json`). One shape for both, so the letter a program has
 * just sent is the letter it later finds in the list.
 */

/**
 * - `accepted` — in the recipient's ledger. It is shown to the recipient at its next turn boundary
 *   (at once when idle, or when `notBefore` comes); `ccmux msg pending` says whether that happened.
 * - `held` — not accepted yet: the recipient's machine was not reached, or answered no; the letter
 *   is recorded here and tried again for the retry window. The note carries what was answered.
 * - `refused` — the recipient's side will refuse it identically however often it is sent; settled.
 * - `recorded` — addressed somewhere ccmux does not deliver; mirrored to the owner, who carries it.
 * - `undelivered` — held past the retry window. Only a look back can say this.
 */
export const SentLetterStateSchema = z
  .enum(['accepted', 'held', 'refused', 'recorded', 'undelivered'])
  .describe(
    "accepted: in the recipient's ledger, shown to it at its next turn boundary. held: not accepted yet — its machine was not reached or answered no — and kept for retry. refused: its side will refuse it however often it is sent; settled, not retried. recorded: addressed where ccmux does not deliver; mirrored to the owner. undelivered: held past the retry window.",
  );
export type SentLetterState = z.infer<typeof SentLetterStateSchema>;

export const SentLetterSchema = z.object({
  /** What a `thread-continuation` to the same recipient cites as its `sourceMessageRef`. Null
   *  unless the letter is `accepted` by a recipient that has a thread. */
  ref: z
    .string()
    .nullable()
    .describe(
      'What a thread-continuation to the same recipient cites as its sourceMessageRef; null unless the letter is accepted by a recipient that has a thread.',
    ),
  state: SentLetterStateSchema,
  id: z.string().min(1),
  /** The recipient's conversation, when it has one. */
  thread: z.string().nullable(),
  to: z.string().min(1),
  task: z.string().nullable(),
  ts: z.string(),
  preview: z.string(),
});
export type SentLetter = z.infer<typeof SentLetterSchema>;

export function sentLetter(message: ChatMessage, state: SentLetterState): SentLetter {
  return {
    // A continuation of a correspondence whose opening letter never arrived is the claim this
    // reference must not help anyone make.
    ref: state === 'accepted' ? continuationRef(message) : null,
    state,
    id: message.id,
    thread:
      message.to.kind === 'managed' || message.to.kind === 'codex-app' ? message.to.threadId : null,
    to: targetLabel(message.to),
    task: message.task,
    ts: message.ts,
    preview: preview(message.body),
  };
}

/** The answer of `ccmux msg sent --json`. */
export const SentListSchema = z.object({
  sender: z.string().min(1),
  sent: z.array(SentLetterSchema),
  /** Letters the same session name sent in an earlier life: their references are not offered. */
  fromEarlierLives: z.int().nonnegative(),
});

/** The answer of `ccmux msg <to> <text> --json`: the one letter, and who it is from. */
export const SendReceiptSchema = SentLetterSchema.extend({
  from: z.string().min(1),
  /** When a timed letter comes due; null for ordinary mail. */
  notBefore: z.string().nullable(),
  /** What the sender is told beside the state: why it is held, who refused it and how, where a
   *  recorded letter goes. Null when the state says everything. */
  note: z
    .string()
    .nullable()
    .describe(
      'What the sender is told beside the state — why it is held, who refused it, where a recorded letter goes; null when the state says everything.',
    ),
});
export type SendReceipt = z.infer<typeof SendReceiptSchema>;
