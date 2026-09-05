import type { ChatCursors, ChatMessage } from '../types.ts';
import { chatTargetKey } from './identity.ts';
import type { LedgerSlot } from './store.ts';

export function conditionalMessage(msg: ChatMessage): boolean {
  return msg.defer || msg.notBefore !== null;
}
export function messageDue(msg: ChatMessage, now: number): boolean {
  const at = msg.notBefore === null ? NaN : Date.parse(msg.notBefore);
  return !Number.isFinite(at) || now >= at;
}

/** Immediate mail retains order; deferred/not-before mail cannot head-of-line block a reply. */
export function pickPendingDelivery(
  ledger: readonly LedgerSlot[],
  recipientKey: string,
  delivered: number,
  acked: ReadonlySet<string>,
  now: number,
): { pick: { msg: ChatMessage; idx: number } | null; cursor: number } {
  for (let idx = delivered; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && chatTargetKey(msg.to) === recipientKey && !conditionalMessage(msg))
      return { pick: { msg, idx }, cursor: idx };
  }
  for (let idx = 0; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (
      msg &&
      chatTargetKey(msg.to) === recipientKey &&
      conditionalMessage(msg) &&
      !acked.has(msg.id) &&
      messageDue(msg, now)
    ) {
      return { pick: { msg, idx }, cursor: ledger.length };
    }
  }
  return { pick: null, cursor: ledger.length };
}

/**
 * Which letter a native delivery pass is about: an unresolved pickup, else the next one in line.
 *
 * Shared with the caller that has to name the message when the pass throws. Recomputing it there
 * would be a second answer to the same question, and the one place it is needed is the place where
 * being wrong is invisible — a hold recorded against the wrong id reads exactly like a right one.
 */
export function pendingMessageId(
  ledger: readonly LedgerSlot[],
  recipientKey: string,
  cursors: ChatCursors,
  acked: ReadonlySet<string>,
  now: number,
): string | undefined {
  const pickup = cursors.pickups[recipientKey];
  if (pickup !== undefined) return pickup.messageId;
  return pickPendingDelivery(ledger, recipientKey, cursors.delivered[recipientKey] ?? 0, acked, now)
    .pick?.msg.id;
}

/**
 * One sentence for a delivery pass that threw, in the recipient's hold.
 *
 * A pass that fails is a hold like any other, and recording it is what keeps `ccmux inbox` honest:
 * with no live reason on record it falls back to "queued — the daemon delivers it (check the daemon
 * is running)", sending whoever waits on the mail to inspect the one component that is healthy. A
 * repeating failure is the case that most needs a name, because it is the one that never clears on
 * its own.
 */
export function nativeDeliveryHold(error: unknown): string {
  return `native delivery failed: ${error instanceof Error ? error.message : String(error)}`;
}
