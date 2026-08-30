import { eventsEnabledFor } from '../../config/events.ts';
import { appendEvent } from '../../events/feed.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { OwnedCodexSnapshot } from './ownedSchema.ts';

/** Existing feed, native boundaries. Reconciliation establishes state; it never replays history. */
export function emitOwnedCodexBoundary(
  m: MachineConfig,
  s: Session,
  snapshot: OwnedCodexSnapshot,
): void {
  if (!eventsEnabledFor(s, m)) return;
  const event = snapshot.events.at(-1);
  if (event === undefined || (event.kind !== 'turn-start' && event.kind !== 'turn-end')) return;
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
