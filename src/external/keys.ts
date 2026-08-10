import type { AgentKind, Session } from "../types.ts";

/** Stable selection identity. Source/origin is deliberately absent: it can change on resume. */
export function externalSessionKey(provider: AgentKind, host: string, threadId: string): string {
  return `external:${provider}:${host}#${threadId}`;
}

/** Managed identity includes the durable registry name; a replacement uuid is a different row. */
export function managedSessionKey(session: Session, host: string): string {
  return `managed:${session.agent}:${host}:${session.name}#${session.uuid}`;
}
