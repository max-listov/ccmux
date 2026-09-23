import { providerFor } from '../agent/index.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { readChatHold } from '../session/status.ts';
import type { ChatMessage, MachineConfig, Session } from '../types.ts';
import { loadAckedIds } from './ackLog.ts';
import { loadCursors } from './cursors.ts';
import { holdReason } from './holdReason.ts';
import { managedPeer, managedPeerKey } from './identity.ts';
import { loadLedger } from './ledger.ts';
import { isDue, pickPendingDelivery } from './settlement.ts';
import { unreadFor } from './store.ts';

/**
 * Chat addressed to this session that is both undelivered AND actually on its way — read fresh on
 * every poll, because mail can arrive mid-wait and a wait that ignored it would answer about the
 * wrong turn.
 *
 * Two kinds of mail are deliberately NOT counted, because waiting on them is waiting on something
 * that cannot happen now (or ever):
 *  - **not due yet** — a router arms its own watchdog with `--after 600`; counting that would make
 *    every `wait` on that router useless for ten minutes while it sits idle;
 *  - **never deliverable** — the recipient has chat off, or its agent has no way to receive chat, so
 *    the daemon skips it forever. `holdReason` already calls this permanent; `wait` must agree.
 */
export function mailBlocksSettle(
  unread: ChatMessage[],
  opts: { chatEnabled: boolean; canReceiveChat: boolean; nowMs: number },
): ChatMessage[] {
  if (!opts.chatEnabled || !opts.canReceiveChat) return [];
  return unread.filter((msg) => isDue(msg, opts.nowMs));
}

/**
 * Why the mail this session is waiting on has not landed.
 *
 * `wait` runs ON the machine that holds the message — everything needed to answer this is a file
 * away, and saying only "waiting on undelivered mail" threw it away. That silence is what the
 * timeout costs: a caller reads it as "the peer is thinking", reports "waiting for a reply", and the
 * peer meanwhile has nothing to reply to. Measured on this fleet: a message held for eleven hours
 * behind a parked composer, three more sent on top of it, and a working session spent reporting a
 * wait that could never end.
 */
export function mailHold(
  m: MachineConfig,
  s: Session,
  blocking: ChatMessage[],
  nowMs: number,
): string | null {
  const first = blocking[0];
  if (first === undefined) return null;
  try {
    return holdReason(first, {
      recipient: s,
      chatEnabled: chatEnabledFor(s, m),
      running: true, // `wait` only reaches this with the session present
      nowMs,
      chatDeliverable: providerFor(s).inspectChatPane !== undefined,
      daemonHold: readChatHold(s.name),
    }).text;
  } catch {
    return null; // diagnosis is a courtesy; never let it break the wait itself
  }
}

export function blockingInbound(m: MachineConfig, s: Session, nowMs: number): ChatMessage[] {
  try {
    if (hasNativeRuntime(s)) {
      if (!chatEnabledFor(s, m)) return [];
      const key = managedPeerKey(managedPeer(m.rcPrefix, s));
      // Reading inbox does not cancel daemon delivery. The delivery cursor, not the
      // human/read cursor, decides whether another native turn is still due.
      const pick = pickPendingDelivery(
        loadLedger(m),
        key,
        loadCursors(m).delivered[key] ?? 0,
        loadAckedIds(m),
        nowMs,
      ).pick;
      return pick === null ? [] : [pick.msg];
    }
    return mailBlocksSettle(
      unreadFor(managedPeer(m.rcPrefix, s), loadLedger(m), loadCursors(m), loadAckedIds(m)).map(
        (u) => u.msg,
      ),
      {
        chatEnabled: chatEnabledFor(s, m),
        canReceiveChat: providerFor(s).inspectChatPane !== undefined,
        nowMs,
      },
    );
  } catch {
    // Chat is optional; a missing or unreadable ledger must never break a plain `wait`.
    return [];
  }
}
