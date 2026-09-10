import { z } from 'zod';
import { AgentKindSchema, RC_PREFIX_RE } from '../config/schema.ts';
import type { AgentKind, Session } from '../types.ts';

const SelectorSchema = z.object({
  provider: AgentKindSchema,
  machine: z.string().regex(RC_PREFIX_RE),
  threadId: z.uuid(),
});

/** Inventory selection is a storage identity, not a managed session or a write address. */
export function parseExternalSessionKey(key: string) {
  const match = /^external:([^:]+):([^:#]+)#([^#]+)$/.exec(key);
  const parsed = SelectorSchema.safeParse({
    provider: match?.[1],
    machine: match?.[2],
    threadId: match?.[3],
  });
  if (!parsed.success) throw new Error('Invalid external inventory key');
  return parsed.data;
}

/** Stable selection identity. Source/origin is deliberately absent: it can change on resume. */
export function externalSessionKey(provider: AgentKind, host: string, threadId: string): string {
  return `external:${provider}:${host}#${threadId}`;
}

/** Managed identity includes the durable registry name; a replacement uuid is a different row. */
export function managedSessionKey(session: Session, host: string): string {
  return `managed:${session.agent}:${host}:${session.name}#${session.uuid}`;
}
