import type { ChatPrincipal, ChatTarget, CliPrincipal, ManagedPeer, OwnerTarget, Session } from "../types.ts";

/** Durable peer key for cursors, acks and equality. Every routing-relevant field participates. */
export function managedPeerKey(peer: ManagedPeer): string {
  return `${peer.source}:${peer.machine}:${peer.agent}:${peer.session}:${peer.threadId}`;
}

export function managedPeer(machine: string, session: Session): ManagedPeer {
  return {
    kind: "managed",
    source: "ccmux",
    machine,
    agent: session.agent,
    session: session.name,
    threadId: session.uuid,
  };
}

export function cliPrincipal(machine: string): CliPrincipal {
  return { kind: "cli", source: "ccmux", machine };
}

export function ownerTarget(): OwnerTarget {
  return { kind: "owner" };
}

export function chatPrincipalKey(principal: ChatPrincipal): string {
  return principal.kind === "managed" ? managedPeerKey(principal) : `${principal.source}:${principal.machine}:cli`;
}

export function chatTargetKey(target: ChatTarget): string {
  return target.kind === "managed" ? managedPeerKey(target) : "owner";
}

export function samePrincipal(left: ChatPrincipal, right: ChatPrincipal): boolean {
  return chatPrincipalKey(left) === chatPrincipalKey(right);
}

export function sameTarget(left: ChatTarget, right: ChatTarget): boolean {
  return chatTargetKey(left) === chatTargetKey(right);
}

export function principalLabel(principal: ChatPrincipal): string {
  if (principal.kind === "cli") return `ccmux/cli@${principal.machine}`;
  return `ccmux/${principal.agent}@${principal.machine}:${principal.session}#${principal.threadId}`;
}

export function targetLabel(target: ChatTarget): string {
  return target.kind === "owner" ? "owner" : principalLabel(target);
}

/**
 * The same endpoint written for a PERSON rather than for an agent.
 *
 * `principalLabel` above is an address something replies to: it carries the provider and the full
 * thread uuid so a peer can answer the exact conversation. That is the right shape in a pane, where
 * an agent reads the tag and copies the reply command out of it.
 *
 * It is the wrong shape in a phone notification. There the uuids are more than half the line and
 * nobody will ever type one — the mirror is one-way, so there is nothing to reply to from that side.
 * `machine:session` is already unique across the fleet (that is what fleet addressing is for), and a
 * managed session pins exactly one thread at creation, so the uuid distinguishes nothing a reader
 * needs. The provider is metadata here, not part of the address.
 */
export function humanLabel(principal: ChatPrincipal): string {
  return principal.kind === "cli" ? `${principal.machine}:cli` : `${principal.machine}:${principal.session}`;
}

/** A human-facing recipient. Mail addressed to the owner says so in their own words. */
export function humanTargetLabel(target: ChatTarget): string {
  return target.kind === "owner" ? "you" : humanLabel(target);
}
