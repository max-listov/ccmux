import { eventsEnabledFor } from '../../config/events.ts';
import { appendEvent } from '../../events/feed.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { OwnedCodexSnapshot } from './ownedSchema.ts';

/**
 * Existing feed, native boundaries. Reconciliation establishes state; it never replays history.
 *
 * Every boundary NEWER than `after` is emitted, and the new high-water mark is returned. Both halves
 * matter, and the version without them said something false about every native session: reading only
 * the ring's last entry, it re-appended whichever boundary happened to still be last on each publish
 * — so a `turn-start` that stayed last was announced again and again, while a `turn-end` overtaken
 * by the next event was never announced at all. Measured on one machine over a day: 2236 starts
 * against 16 ends for native sessions, and 193 against 193 for the sessions whose boundaries come
 * from turn hooks instead. A feed that says a session began work two thousand times and finished it
 * sixteen is not a slightly noisy feed; every count, every duration and every "is it working" read
 * from it was wrong, and it looked exactly like a working instrument.
 */
export function emitOwnedCodexBoundary(
  m: MachineConfig,
  s: Session,
  snapshot: OwnedCodexSnapshot,
  after: number,
): number {
  if (!eventsEnabledFor(s, m)) return after;
  let emitted = after;
  for (const event of snapshot.events) {
    if (event.sequence <= after) continue;
    emitted = Math.max(emitted, event.sequence);
    if (event.kind !== 'turn-start' && event.kind !== 'turn-end') continue;
    const started = event.turn?.startedAt;
    appendEvent(m, s, {
      event: event.kind,
      ...(event.kind === 'turn-end' && started
        ? { durationMs: Math.max(0, Date.parse(event.at) - Date.parse(started)) }
        : {}),
      ...(event.kind === 'turn-end' && event.turn?.status !== 'completed'
        ? { interrupted: true, detail: `native turn ${event.turn?.status ?? 'unknown'}` }
        : {}),
    });
  }
  return emitted;
}
