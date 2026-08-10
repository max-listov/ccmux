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
