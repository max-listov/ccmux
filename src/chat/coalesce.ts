import type { ChatMessage } from '../types.ts';
import { managedPeerKey } from './identity.ts';
import type { LedgerSlot } from './ledger.ts';
import { isConditional, isDue } from './settlement.ts';

/**
 * How many waiting letters are handed over at once, and how much text that may be.
 *
 * Bounded because a session that was busy for an hour must not come back to a wall: the rest stay
 * queued and arrive at the next boundary, which is the same promise repeated rather than a new one.
 */
export const MAX_BATCH = 8;

export const MAX_BATCH_BYTES = 16_000;

/**
 * A letter an application says a person wrote.
 *
 * An attested claim, not an authenticated identity — the ingress attests the author category and
 * nothing here has verified the human. That is enough for THIS use and for no other: it decides
 * which letter keeps its place in a full batch, which grants no authority and cannot be abused into
 * any. Deciding it by principal was the trap: `cli` means "a person or an agent at a shell" by its
 * own definition, so preferring it would prefer half the agent traffic.
 */
export const fromPerson = (msg: ChatMessage): boolean => msg.origin?.actor === 'human';

/**
 * Every letter now waiting for this recipient's boundary, in the order they were written.
 *
 * The first one is what the gates above were decided on; these are the others that would otherwise
 * each cost the recipient a separate turn — and the second of them would land INSIDE the turn the
 * first had just started, which is the interruption this whole path exists to avoid.
 *
 * The batch is bounded, so something has to be the letter that does not fit, and by arrival time
 * alone that was whatever came last — a person writing to a session with a dozen queued peer
 * letters waited a whole extra turn behind chatter. So the bound cuts agent letters first: what is
 * SELECTED is ordered person-first, and what is SENT is put back in the order it was written,
 * because a conversation read out of order is worse than a letter arriving a turn late.
 *
 * The oldest waiting letter always travels, whoever wrote it. It is the one the delivery gates were
 * decided on above, and a letter that keeps losing its place to newer ones is the starvation this
 * whole queue exists to avoid.
 */
export function coalesce(
  ledger: readonly LedgerSlot[],
  recipientKey: string,
  acked: ReadonlySet<string>,
  now: number,
): ChatMessage[] {
  const waiting: ChatMessage[] = [];
  for (const msg of ledger) {
    if (msg === null || msg.to.kind !== 'managed' || managedPeerKey(msg.to) !== recipientKey)
      continue;
    if (!isConditional(msg) || acked.has(msg.id) || !isDue(msg, now)) continue;
    waiting.push(msg);
  }
  const [oldest, ...rest] = waiting;
  if (oldest === undefined) return [];
  const selected = new Set<string>();
  let bytes = 0;
  for (const msg of [oldest, ...rest.filter(fromPerson), ...rest.filter((m) => !fromPerson(m))]) {
    bytes += Buffer.byteLength(msg.body);
    if (selected.size >= MAX_BATCH || (selected.size > 0 && bytes > MAX_BATCH_BYTES)) break;
    selected.add(msg.id);
  }
  return waiting.filter((msg) => selected.has(msg.id));
}
