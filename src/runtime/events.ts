import type { MachineConfig, Session } from "../types.ts";
import { eventsEnabledFor } from "../config/events.ts";
import { appendEvent } from "../events/feed.ts";
import type { ManagedRuntimeSnapshot } from "./schema.ts";

/** Live native boundaries enter the existing event feed. Restore establishes a cursor, not replay. */
export function emitRuntimeBoundaries(m: MachineConfig, s: Session, snapshot: ManagedRuntimeSnapshot, after: number): void {
  if (!eventsEnabledFor(s, m)) return;
  for (const event of snapshot.events) {
    if (event.sequence <= after || (event.kind !== "turn-start" && event.kind !== "turn-end")) continue;
    const started = event.turn?.startedAt;
    appendEvent(m, s, { event: event.kind,
      ...(event.kind === "turn-end" && started ? { durationMs: Math.max(0, Date.parse(event.at) - Date.parse(started)) } : {}),
      ...(event.kind === "turn-end" && event.turn?.status !== "completed"
        ? { interrupted: true, detail: `native turn ${event.turn?.status ?? "unknown"}` } : {}) });
  }
}
