import type { MachineConfig, Session } from "../types.ts";

/**
 * Is inter-agent chat on for this session?
 *
 * The ONE place that resolves the two levels — a session override, else the machine default. Eleven
 * call sites read this flag (delivery, sending, the injected prompt, the Stop hook, `doctor`,
 * `wait`, `send`, the launch stamp); each of them folding "session ?? machine" itself is how half a
 * system ends up believing chat is on while the other half does not.
 *
 * The default stays OFF at both levels: chat traffic is never implicit. What the machine level buys
 * is that the deliberate act happens once per box instead of once per session — and that forgetting
 * it stops being something you discover when a peer does not answer.
 */
export function chatEnabledFor(s: Session, m: MachineConfig): boolean {
  return s.chatEnabled ?? m.chatEnabled;
}
