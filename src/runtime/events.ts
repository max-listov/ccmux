import { eventsEnabledFor } from '../config/events.ts';
import { appendEvent } from '../events/feed.ts';
import type { MachineConfig, Session } from '../types.ts';

/** What a native runtime's snapshot says about its boundaries — the shape every runtime shares. */
interface BoundarySnapshot {
  events: readonly {
    sequence: number;
    kind: string;
    at: string;
    turn?: { startedAt?: string | null; status?: string } | null;
  }[];
}

/**
 * Native turn boundaries enter the event feed: every one newer than `after`, once. Returns the new
 * high-water mark, which the caller hands back next time.
 *
 * Both halves matter. Reading only the ring's last entry re-appended whichever boundary happened to
 * still be last on each publish — a `turn-start` that stayed last was announced again and again, while
 * a `turn-end` overtaken by the next event was never announced at all: measured on one machine over a
 * day, 2236 starts against 16 ends for native sessions, and 193 against 193 for the sessions whose
 * boundaries come from turn hooks. The mark advances whether or not the session's events are enabled,
 * so turning them on starts the feed from now instead of replaying the ring.
 */
export function emitRuntimeBoundaries(
  m: MachineConfig,
  s: Session,
  snapshot: BoundarySnapshot,
  after: number,
): number {
  const enabled = eventsEnabledFor(s, m);
  let mark = after;
  for (const event of snapshot.events) {
    if (event.sequence <= after) continue;
    mark = Math.max(mark, event.sequence);
    if (!enabled || (event.kind !== 'turn-start' && event.kind !== 'turn-end')) continue;
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
  return mark;
}
