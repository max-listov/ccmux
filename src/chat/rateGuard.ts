import type { ChatTarget } from '../types.ts';
import { chatTargetKey } from './identity.ts';
import type { LedgerSlot } from './ledger.ts';

// Loop/rate guard: hold delivery once a recipient has received more than this many messages within
// the rolling window. A runaway A→B→A ping-pong inflates BOTH sides' inbound rate → both pause →
// the loop breaks. Generous for a "phone call" channel; a genuine burst just spreads over time.
const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_INBOUND = 12;

/** Messages addressed to `name` sent within the window (by ledger `ts`). Pure — `nowMs` passed in. */
export function recentInboundCount(
  recipient: ChatTarget,
  ledger: readonly LedgerSlot[],
  nowMs: number,
): number {
  let n = 0;
  for (const msg of ledger) {
    if (msg === null || chatTargetKey(msg.to) !== chatTargetKey(recipient)) continue;
    const t = Date.parse(msg.ts);
    if (Number.isFinite(t) && nowMs - t <= RATE_WINDOW_MS) n += 1;
  }
  return n;
}
