import { randomUUID } from 'node:crypto';
import { CHAT_GENERATION, ChatMessageSchema } from '../config/schema.ts';
import type { ChatMessage, ChatPrincipal, ChatTarget } from '../types.ts';
import { principalOrigin } from './origin.ts';

/**
 * Build one immutable v2 envelope.
 *
 * It lives in its own module because `msg` is no longer the only thing that writes to the ledger: the
 * fleet sweep reports its own result the same way. That is deliberate — `restart --then "<note>"` was
 * removed in 0.12.0 precisely because a note carried on a lifecycle flag has no sender, no reply
 * address and no entry in the ledger, and anything that wants to tell an agent something has to go
 * through a recorded envelope instead. Sharing the constructor is what keeps that true: a second
 * hand-rolled message shape would be a second way to be un-recorded.
 */
export function buildEnvelope(
  from: ChatPrincipal,
  to: ChatTarget,
  body: string,
  opts?: {
    task?: string | null;
    defer?: boolean;
    onBehalfOf?: string | null;
    notBefore?: string | null;
  },
): ChatMessage {
  return ChatMessageSchema.parse({
    v: CHAT_GENERATION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    from,
    to,
    origin: principalOrigin(from),
    notification: to.kind === 'owner' || to.kind === 'external' ? 'owner' : 'conversation',
    body,
    task: opts?.task ?? null,
    defer: opts?.defer ?? false,
    onBehalfOf: opts?.onBehalfOf ?? null,
    notBefore: opts?.notBefore ?? null,
  });
}
