import { chatCursorsPath, chatLedgerPath } from '../config/paths.ts';
import { loadSessions } from '../session/registry.ts';
import type {
  ChatCursors,
  ChatMessage,
  ChatPrincipal,
  ChatTarget,
  MachineConfig,
  ManagedPeer,
} from '../types.ts';
import type { AckOutcome } from './ackLog.ts';
import {
  chatTargetKey,
  managedPeer,
  managedPeerKey,
  principalLabel,
  sameSender,
  sameTarget,
  targetLabel,
} from './identity.ts';
import type { LedgerSlot } from './ledger.ts';
import { isConditional, letterState } from './settlement.ts';

/** Reserved chat recipient = the human who runs the fleet. A message TO `owner` is NOT delivered
 *  to any pane (the owner has none) — it only surfaces out-of-band (Telegram, and later a frontend).
 *  A message FROM `owner` is the human, not a peer agent. Not a session name; can't collide because
 *  delivery only ever targets real sessions. */
export const OWNER = 'owner';

/** Reserved SENDER = the command-line operator (a human or Claude driving `ccmux msg` from a shell) —
 *  NOT a managed session, NOT the owner. It's the default `from` for a command-line send, so those
 *  read as `cli → …` (and never masquerade as the owner). Not a delivery target. */
export const CLI = 'cli';

/**
 * Inter-agent chat storage — an append-only ledger (source of truth) + a small cursors file. Both
 * live in the instance's state directory, so a config built for a test gives that test its own
 * chat store, and a machine keeps exactly one store beside its one registry.
 */
export function chatPaths(m: MachineConfig): { ledger: string; cursors: string } {
  return { ledger: chatLedgerPath(m), cursors: chatCursorsPath(m) };
}

// The defer-delivery ack-log (`chatAckPath`) is an append-only record of which DEFER messages have
// been injected, keyed by message id. It is how the Stop hook and the daemon coordinate WITHOUT
// sharing a mutable cursor (which would lose-update — see the design doc's R5): each appends one
// O_APPEND line (atomic across processes, like the ledger), and both check it before delivering, so
// a message is injected exactly once. The hook never touches `cursors`; the daemon owns every field
// but `read`, which `ccmux inbox` advances too — see `commitCursors` for how the two never overwrite
// each other.

/**
 * Recipients this machine can still deliver to, by exact peer key.
 *
 * A letter addressed to a session that has since been removed is not waiting for anything: delivery
 * walks the live sessions, so nobody will ever pick it up, and counting it as outstanding says a
 * colleague is owed an answer that no one can give.
 *
 * By KEY, not by name: the key carries the conversation uuid, so a name freed and taken by a new
 * session does not silently adopt the previous occupant's mail. Absence is therefore permanent,
 * which is what makes it safe for `settleUndeliverable` to close such a letter for good. Nothing is
 * deleted; the ledger is append-only and keeps every letter that was ever sent — what ends is the
 * waiting, and the ack row records how it ended.
 */
export function deliverableTargets(m: MachineConfig): ReadonlySet<string> {
  return new Set(loadSessions(m).map((session) => chatTargetKey(managedPeer(m.rcPrefix, session))));
}

function undeliverable(msg: ChatMessage, live: ReadonlySet<string> | undefined): boolean {
  return live !== undefined && msg.to.kind === 'managed' && !live.has(chatTargetKey(msg.to));
}

/** `from` matches the sender's SESSION, not the life of it that sent the letter: see `sameSender`.
 *  Undelivered CONDITIONAL messages (deferred or time-delayed), optionally filtered by sender /
 *  recipient / task. "Undelivered" = not yet in the ack-log (neither delivered nor already
 *  cancelled). This is the set `msg cancel` tombstones and the set a re-armed `--task` replaces.
 *  notBefore due-ness is intentionally NOT considered — a future-dated watchdog is still pending. */
export function pendingConditional(
  ledger: readonly LedgerSlot[],
  acks: ReadonlyMap<string, AckOutcome>,
  filter: { from?: ChatPrincipal; to?: ChatTarget; task?: string; live?: ReadonlySet<string> },
): ChatMessage[] {
  return ledger.filter((msg, index): msg is ChatMessage => {
    if (msg === null) return false; // a record this build cannot read is not a message it can cancel
    if (undeliverable(msg, filter.live)) return false;
    if (!isConditional(msg)) return false; // immediate mail is delivered at once
    if (letterState(msg, index, acks, NO_CURSORS) !== 'pending') return false;
    if (filter.from !== undefined && !sameSender(msg.from, filter.from)) return false;
    if (filter.to !== undefined && !sameTarget(msg.to, filter.to)) return false;
    if (filter.task !== undefined && msg.task !== filter.task) return false;
    return true;
  });
}

/** Conditional letters are settled by the ack log alone; their state never reads a cursor. */
const NO_CURSORS = { delivered: {}, telegram: null } as const;

/**
 * Immediate mail from this sender for this task that its recipient has not been handed yet.
 *
 * `msg cancel` deliberately withdraws conditional mail only: immediate mail is delivered at the
 * recipient's next opportunity and there is nothing to hold back. That makes its count of zero
 * indistinguishable from "nothing is waiting" — the reading a sender takes when a letter has been
 * overtaken by events and they want it gone. Naming what cancel could not touch is what separates
 * those two, and the letters are still on their way.
 */
export function pendingImmediate(
  ledger: readonly LedgerSlot[],
  cursors: ChatCursors,
  filter: { from?: ChatPrincipal; task?: string; live?: ReadonlySet<string> },
): ChatMessage[] {
  return ledger.filter((msg, index): msg is ChatMessage => {
    if (msg === null) return false;
    if (undeliverable(msg, filter.live)) return false;
    if (isConditional(msg)) return false;
    if (filter.from !== undefined && !sameSender(msg.from, filter.from)) return false;
    if (filter.task !== undefined && msg.task !== filter.task) return false;
    return letterState(msg, index, NO_ACKS, cursors) === 'pending';
  });
}

/** Immediate letters are settled by cursors alone; their state never reads the ack log. */
const NO_ACKS: ReadonlyMap<string, AckOutcome> = new Map();

/**
 * Unread inbox for a recipient: messages addressed TO it at/after its read cursor.
 *
 * `acked` closes a real hole: CONDITIONAL mail (defer / notBefore) is delivered OFF the cursor and
 * recorded only in the ack-log, so the read cursor never advances past it. Without consulting the
 * ack-log, an already-injected deferred message stayed in `inbox` forever — contradicting the
 * documented contract ("a message already pushed to the pane isn't here") and making any
 * "why hasn't this been delivered" answer lie about mail that HAS been delivered.
 */
export function unreadFor(
  recipient: ManagedPeer,
  ledger: readonly LedgerSlot[],
  cursors: ChatCursors,
  acked?: ReadonlySet<string>,
): { msg: ChatMessage; idx: number }[] {
  const key = managedPeerKey(recipient);
  const since = cursors.read[key] ?? 0;
  const activePickupId = cursors.pickups[key]?.messageId;
  const out: { msg: ChatMessage; idx: number }[] = [];
  for (let idx = 0; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg?.to.kind !== 'managed' || managedPeerKey(msg.to) !== key) continue;
    if (msg.id === activePickupId) continue; // already armed/injected; transcript pickup owns it
    if (acked?.has(msg.id) === true) continue; // already injected (Stop hook or daemon) — not pending
    // The two tracks are asked the same question delivery asks them, because anything else makes
    // this listing disagree with what is actually queued. Immediate mail is behind the read cursor;
    // conditional mail is NOT — its authority is the ack-log, and it is delivered off-cursor by id.
    // Reading both off the cursor hid deferred letters the moment an immediate one moved it past
    // them: still unacked, still due for delivery, and absent from the one command that answers
    // "what is waiting for me". Measured on a live fleet when this was found: four such letters,
    // invisible here while the daemon still held them.
    if (!isConditional(msg) && idx < since) continue;
    out.push({ msg, idx });
  }
  return out;
}

/** One-line human render with the complete pinned endpoint identities. Shared by inbox + log. */
export function fmtMessage(msg: ChatMessage): string {
  const t = msg.ts.replace('T', ' ').slice(0, 19);
  const task = msg.task ? ` (task: ${msg.task})` : '';
  return `[${t}] ${principalLabel(msg.from)} → ${targetLabel(msg.to)}${task}: ${msg.body}`;
}

/** The next undelivered message addressed to an exact managed peer, scanning from ledger index `from`, with its
 *  absolute index — or null if none. Pure: the daemon uses `idx` to advance the per-recipient
 *  delivered cursor (past skipped non-recipient messages) and preserves in-order delivery. */
export function nextForRecipient(
  recipient: ManagedPeer,
  ledger: ChatMessage[],
  from: number,
): { msg: ChatMessage; idx: number } | null {
  const key = managedPeerKey(recipient);
  for (let idx = Math.max(0, from); idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && msg.to.kind === 'managed' && managedPeerKey(msg.to) === key) return { msg, idx };
  }
  return null;
}
