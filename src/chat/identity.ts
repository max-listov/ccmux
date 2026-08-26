import type { ChatPrincipal, ChatTarget, CliPrincipal, CodexAppPeer, ExternalTarget, ManagedPeer, OwnerTarget, Session } from "../types.ts";

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

export function codexAppPeer(machine: string, threadId: string, name: string | null): CodexAppPeer {
  return { kind: "codex-app", source: "codex-app", machine, agent: "codex", threadId, name };
}

export const CODEX_APP_PREFIX = "app/";

export function isCodexAppToken(token: string): boolean {
  return token.startsWith(CODEX_APP_PREFIX) && token.length > CODEX_APP_PREFIX.length;
}

export function codexAppThreadId(token: string): string {
  return token.slice(CODEX_APP_PREFIX.length);
}

export function codexAppAddress(threadId: string): string {
  return `${CODEX_APP_PREFIX}${threadId}`;
}

export function ownerTarget(): OwnerTarget {
  return { kind: "owner" };
}

/** The address form a person types and reads: `owner/<name>`. It SAYS the route — this party is
 *  reached through the owner — and it carries no colon, so it can never be mistaken for
 *  `<machine>:<session>`. */
export const EXTERNAL_PREFIX = "owner/";

export function externalTarget(name: string): ExternalTarget {
  return { kind: "external", source: "ccmux", name };
}

export function externalAddress(name: string): string {
  return `${EXTERNAL_PREFIX}${name}`;
}

export function chatPrincipalKey(principal: ChatPrincipal): string {
  if (principal.kind === "managed") return managedPeerKey(principal);
  if (principal.kind === "codex-app") return `${principal.source}:${principal.machine}#${principal.threadId}`;
  return `${principal.source}:${principal.machine}:cli`;
}

export function chatTargetKey(target: ChatTarget): string {
  if (target.kind === "managed") return managedPeerKey(target);
  if (target.kind === "codex-app") return `${target.source}:${target.machine}#${target.threadId}`;
  return target.kind === "owner" ? "owner" : `external:${target.name}`;
}

export function samePrincipal(left: ChatPrincipal, right: ChatPrincipal): boolean {
  return chatPrincipalKey(left) === chatPrincipalKey(right);
}

export function sameTarget(left: ChatTarget, right: ChatTarget): boolean {
  return chatTargetKey(left) === chatTargetKey(right);
}

export function principalLabel(principal: ChatPrincipal): string {
  if (principal.kind === "cli") return `ccmux/cli@${principal.machine}`;
  if (principal.kind === "codex-app") return `codex-app@${principal.machine}:${principal.name ?? "thread"}#${principal.threadId}`;
  return `ccmux/${principal.agent}@${principal.machine}:${principal.session}#${principal.threadId}`;
}

export function targetLabel(target: ChatTarget): string {
  if (target.kind === "owner") return "owner";
  return target.kind === "external" ? externalAddress(target.name) : principalLabel(target);
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
  if (principal.kind === "cli") return `${principal.machine}:cli`;
  if (principal.kind === "codex-app") return `${principal.machine}:${principal.name ?? codexAppAddress(principal.threadId)}`;
  return `${principal.machine}:${principal.session}`;
}

/** A human-facing recipient. Mail addressed to the owner says so in their own words. */
export function humanTargetLabel(target: ChatTarget): string {
  if (target.kind === "owner") return "you";
  // Named as what a person has to DO with it, because for this one recipient they are the transport.
  return target.kind === "external" ? `${target.name} (outside the fleet — relay this)` : humanLabel(target);
}
