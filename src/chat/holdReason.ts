import type { ChatMessage, Session } from "../types.ts";
import { targetLabel } from "./identity.ts";

/**
 * Why is this message still sitting undelivered?
 *
 * Answering "it just hasn't arrived" is what cost hours in the 2026-08-05 incident: the sender had
 * no way to tell "held for a good reason" from "went to the wrong machine". Most reasons are
 * DERIVABLE — no pane capture, no tmux, pure over the ledger + the registry — so `inbox` can answer
 * them itself. The three that genuinely need live pane state (menu, human typing, defer waiting for
 * a turn to end) are recorded by the daemon at the moment it holds, and read back here; re-deriving
 * them in `inbox` would be a second source of truth AND systematically wrong, since `inbox` usually
 * runs from inside the very session it asks about (which therefore always looks "busy").
 */
export type HoldReason =
  | { kind: "recipient-unknown"; text: string }
  | { kind: "recipient-stopped"; text: string }
  | { kind: "chat-off"; text: string }
  | { kind: "agent-unsupported"; text: string }
  | { kind: "owner"; text: string }
  | { kind: "not-due"; text: string }
  | { kind: "awaiting-turn-end"; text: string }
  | { kind: "live"; text: string } // whatever the daemon recorded (menu / typing / rate limit / not settled)
  | { kind: "pending"; text: string };

export interface HoldContext {
  recipient: Session | undefined;
  running: boolean;
  nowMs: number;
  /** Can the recipient's agent receive chat at all? False = the daemon skips it entirely, so its mail
   *  is not "slow", it is never coming. */
  chatDeliverable?: boolean;
  /** True when `to` is the reserved `owner` — the human has no pane, so mail waits for a mirror. */
  isOwner?: boolean;
  /** The daemon's last hold for this recipient, if fresh — and the message it was ABOUT. */
  daemonHold?: { reason: string; msgId: string | null } | null;
}

/** Pure: message + recipient state → the honest reason it hasn't landed yet. */
export function holdReason(msg: ChatMessage, ctx: HoldContext): HoldReason {
  const sessionName = msg.to.kind === "managed" ? msg.to.session : "owner";
  if (ctx.isOwner === true) {
    return { kind: "owner", text: "addressed to you — there is no pane to deliver to; it surfaces via the Telegram mirror if configured" };
  }
  if (ctx.recipient === undefined) {
    return { kind: "recipient-unknown", text: `no exact session '${targetLabel(msg.to)}' on this machine — it may belong to another fleet machine or have been replaced` };
  }
  if (!ctx.recipient.chatEnabled) {
    return { kind: "chat-off", text: `recipient has chat disabled (ccmux chat on ${sessionName}, then restart it)` };
  }
  // Permanent, not transient: an agent with no safe-to-inject detector is skipped by the delivery
  // loop outright, so calling this "queued" would promise something that can never happen.
  if (ctx.chatDeliverable === false) {
    return { kind: "agent-unsupported", text: `recipient runs ${ctx.recipient.agent}, which cannot receive chat — this will never be delivered` };
  }
  if (!ctx.running) return { kind: "recipient-stopped", text: `recipient is not running (ccmux start ${sessionName})` };
  if (msg.notBefore !== null) {
    const due = Date.parse(msg.notBefore);
    if (Number.isFinite(due) && ctx.nowMs < due) {
      return { kind: "not-due", text: `scheduled — not before ${msg.notBefore} (${Math.ceil((due - ctx.nowMs) / 1000)}s)` };
    }
  }
  // Only for the message the daemon was actually holding. A reason recorded about a different letter
  // is not evidence about this one.
  const hold = ctx.daemonHold;
  if (hold != null && hold.reason !== "" && (hold.msgId === null || hold.msgId === msg.id)) {
    return { kind: "live", text: hold.reason };
  }
  // Deliberately does NOT assert that a turn is in progress. This branch is reached whenever the
  // daemon has no fresh hold on record — which happens when the daemon is not running at all, when
  // this letter sits behind an immediate one (the daemon never picked it, so never held about it),
  // and when a pass hit its per-tick delivery cap. Claiming "waiting for the turn to finish" in
  // those cases was simply false.
  if (msg.defer) return { kind: "awaiting-turn-end", text: "deferred — delivered at the recipient's next turn boundary; no live reason on record (the daemon has not picked it up yet, or is not running)" };
  return { kind: "pending", text: "queued — the daemon delivers it (if nothing appears, check the daemon is running: ccmux doctor)" };
}
