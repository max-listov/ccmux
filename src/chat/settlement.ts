import type { ChatCursors, ChatMessage } from '../types.ts';
import type { AckOutcome } from './ackLog.ts';
import { chatTargetKey } from './identity.ts';
import type { LedgerSlot } from './ledger.ts';

/**
 * The rules every question about a letter's state is answered by — delivery, `msg pending`, `inbox`,
 * cancellation and the undeliverable sweep alike.
 *
 * They were written out wherever they were needed: "is this letter conditional" six times, "is it
 * due" twice under two names, "which letter is next" three times. The copies agreed today; that they
 * agree tomorrow depended on every future edit finding all of them.
 */

/** A message is CONDITIONAL — delivered off the in-order cursor, tracked by id in the ack log — when
 *  it is deferred or carries a notBefore. Everything else is IMMEDIATE and flows through the
 *  monotonic cursor. The split is what lets a future-dated watchdog, or a held defer, not block an
 *  immediate reply that arrives behind it. */
export function isConditional(msg: Pick<ChatMessage, 'defer' | 'notBefore'>): boolean {
  return msg.defer || msg.notBefore !== null;
}

/** notBefore satisfied, or absent. An unparseable timestamp counts as due: a bad field must never
 *  trap a letter for ever. */
export function isDue(msg: Pick<ChatMessage, 'notBefore'>, now: number): boolean {
  if (msg.notBefore === null) return true;
  const at = Date.parse(msg.notBefore);
  return !Number.isFinite(at) || now >= at;
}

/**
 * Where one letter stands, from the two records that decide it.
 *
 * A conditional letter is settled by the ack log, whatever the cursors say; an immediate one by its
 * recipient's delivery cursor passing it, never by the ack log — and a letter to the owner by the
 * Telegram mirror's index, because the owner has no pane and no delivery cursor ever advances for
 * them. An immediate letter the undeliverable sweep closed reads as `delivered`: the sweep closes it
 * by moving the same cursor, and the two are not told apart by this record.
 */
export type LetterState = 'pending' | 'delivered' | 'cancelled' | 'undeliverable';

export function letterState(
  msg: ChatMessage,
  index: number,
  acks: ReadonlyMap<string, AckOutcome>,
  cursors: Pick<ChatCursors, 'delivered' | 'telegram'>,
): LetterState {
  if (isConditional(msg)) return acks.get(msg.id) ?? 'pending';
  const passed =
    msg.to.kind === 'owner'
      ? (cursors.telegram ?? 0) > index
      : (cursors.delivered[chatTargetKey(msg.to)] ?? 0) > index;
  return passed ? 'delivered' : 'pending';
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
    if (msg && chatTargetKey(msg.to) === recipientKey && !isConditional(msg))
      return { pick: { msg, idx }, cursor: idx };
  }
  for (let idx = 0; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (
      msg &&
      chatTargetKey(msg.to) === recipientKey &&
      isConditional(msg) &&
      !acked.has(msg.id) &&
      isDue(msg, now)
    ) {
      return { pick: { msg, idx }, cursor: ledger.length };
    }
  }
  return { pick: null, cursor: ledger.length };
}

/**
 * The next letter to push to a recipient, with its delivered cursor caught up.
 *
 * Track A is the next IMMEDIATE letter at or after the cursor — the cursor catches up to it, or to
 * the end; Track B, only when A has nothing, is the first due and unresolved conditional letter.
 * Conditional mail is skipped by A, which is what prevents head-of-line blocking. `moved` says the
 * cursor changed and has to be saved.
 */
export function nextDelivery(
  ledger: readonly LedgerSlot[],
  recipientKey: string,
  cursors: Pick<ChatCursors, 'delivered'>,
  acked: ReadonlySet<string>,
  now: number,
): { pick: { msg: ChatMessage; idx: number } | null; moved: boolean } {
  const next = pickPendingDelivery(
    ledger,
    recipientKey,
    cursors.delivered[recipientKey] ?? 0,
    acked,
    now,
  );
  const moved = cursors.delivered[recipientKey] !== next.cursor;
  if (moved) cursors.delivered[recipientKey] = next.cursor;
  return { pick: next.pick, moved };
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
