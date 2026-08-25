import type { MachineConfig, Session } from "../types.ts";

/**
 * Does this session emit events?
 *
 * The ONE place that resolves the two levels — a session override, else the machine default —
 * exactly like `chatEnabledFor`. Both writers (the turn hook and the daemon) go through it, so a
 * session cannot be half-silent: emitting turn boundaries while its waiting state stays hidden would
 * be worse than either answer, because a reader would see starts with no ends and conclude the
 * session had hung.
 *
 * The default is ON, unlike chat. Chat sends traffic to other agents and must be deliberate; an
 * event is a line in this machine's own file that nobody has to read.
 */
export function eventsEnabledFor(s: Session, m: MachineConfig): boolean {
  return s.eventsEnabled ?? m.sessionEvents;
}
