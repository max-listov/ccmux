import { chatAckPath } from '../config/paths.ts';
import type { ChatTarget, MachineConfig } from '../types.ts';
import { appendJsonl, readJsonl } from '../util/jsonl.ts';
import { chatTargetKey } from './identity.ts';

/** What became of a conditional message: it reached the pane, or it never will. All three suppress
 *  delivery identically, which is why they share a log — but they are different answers to "where is
 *  my message", and only one of them means someone read it. `undeliverable` is the third: the
 *  recipient session no longer exists, so nobody withdrew the letter and nobody ever received it. */
export type AckOutcome = 'delivered' | 'cancelled' | 'undeliverable';

/** Every acked id with what happened to it. Lenient: a corrupt line is skipped, not thrown — the
 *  hook must never wedge a session's ability to stop over a bad ack line. A later line wins, so a
 *  cancel racing a delivery settles on whichever actually happened last. */
export function loadAcks(m: MachineConfig): Map<string, AckOutcome> {
  return new Map(readJsonl(chatAckPath(m), ACKS));
}

export const ACKS = {
  label: 'chat ack log',
  // A best-effort dedup log, not authoritative history: a bad line is skipped, never thrown — the
  // hook must never wedge a session's ability to stop over one.
  badLine: 'skip',
  decode: (raw: unknown): [string, AckOutcome] | undefined => {
    if (raw === null || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string')
      return undefined;
    const by = 'by' in raw ? raw.by : undefined;
    // Named explicitly, never by exclusion: a reason this build does not know is a delivery it
    // cannot attest, and reporting it as one would put a letter's fate in the log wrongly.
    return [
      raw.id,
      by === 'cancel' ? 'cancelled' : by === 'undeliverable' ? 'undeliverable' : 'delivered',
    ];
  },
} as const;

/** Set of message ids already resolved (defer channel), delivered or cancelled alike — which is
 *  what every delivery gate needs to know. Derived from the one reader above rather than parsed a
 *  second time, so the two can never disagree about which ids are in the log. */
export function loadAckedIds(m: MachineConfig): Set<string> {
  return new Set(loadAcks(m).keys());
}

/** Record a conditional-message resolution in the ack-log. `by`:
 *   - `hook`/`daemon` — DELIVERED (injected into the pane by that process);
 *   - `cancel`        — CANCELLED before delivery (`msg cancel`, or replaced by a re-armed watchdog);
 *   - `undeliverable` — the recipient session no longer exists, so it never will be delivered.
 * All of them suppress future delivery identically (both the daemon and the Stop hook skip any id in
 * this log), so a cancel is just a delivery that will never happen — the honest `by` keeps the log
 * readable. O_APPEND single-line write is atomic across the hook + daemon + sender processes. */
export function appendAck(
  m: MachineConfig,
  id: string,
  by: 'hook' | 'daemon' | 'cancel' | 'undeliverable',
  to: ChatTarget,
): void {
  appendJsonl(chatAckPath(m), { id, ts: new Date().toISOString(), by, to: chatTargetKey(to) });
}
