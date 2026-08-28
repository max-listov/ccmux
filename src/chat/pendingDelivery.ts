import type { ChatMessage } from "../types.ts";
import type { LedgerSlot } from "./store.ts";
import { chatTargetKey } from "./identity.ts";

export function conditionalMessage(msg: ChatMessage): boolean { return msg.defer || msg.notBefore !== null; }
export function messageDue(msg: ChatMessage, now: number): boolean {
  const at = msg.notBefore === null ? NaN : Date.parse(msg.notBefore);
  return !Number.isFinite(at) || now >= at;
}

/** Immediate mail retains order; deferred/not-before mail cannot head-of-line block a reply. */
export function pickPendingDelivery(ledger: readonly LedgerSlot[], recipientKey: string, delivered: number,
  acked: ReadonlySet<string>, now: number): { pick: { msg: ChatMessage; idx: number } | null; cursor: number } {
  for (let idx = delivered; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && chatTargetKey(msg.to) === recipientKey && !conditionalMessage(msg)) return { pick: { msg, idx }, cursor: idx };
  }
  for (let idx = 0; idx < ledger.length; idx++) {
    const msg = ledger[idx];
    if (msg && chatTargetKey(msg.to) === recipientKey && conditionalMessage(msg) && !acked.has(msg.id) && messageDue(msg, now)) {
      return { pick: { msg, idx }, cursor: ledger.length };
    }
  }
  return { pick: null, cursor: ledger.length };
}
