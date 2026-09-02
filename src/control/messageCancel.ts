import type { z } from 'zod';
import { isConditional } from '../chat/deliver.ts';
import { samePrincipal } from '../chat/identity.ts';
import { appendAck, loadAcks, loadLedger } from '../chat/store.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import type { ControlMessageCancelSchema } from './schema.ts';

/**
 * Withdraw one accepted letter that has not reached the recipient.
 *
 * The ack log already carried the distinction between a letter that was delivered and one that was
 * cancelled — both suppress delivery, and only one of them means somebody read it. This reads it
 * back, so the answer is what happened rather than "it will not be delivered now", which is true of
 * both and useful for neither.
 *
 * An immediate letter has no cancel: it is delivered off the in-order cursor and does not wait, so
 * there is no interval in which to take it back. Saying `delivered` for one is the truth.
 */
export function cancelControlMessage(
  m: MachineConfig,
  input: z.output<typeof ControlMessageCancelSchema>,
  principal: ChatPrincipal,
): { messageId: string; outcome: 'cancelled' | 'delivered' | 'unknown' | 'not-yours' } {
  const message = loadLedger(m).find((slot) => slot !== null && slot.id === input.messageId);
  if (!message) return { messageId: input.messageId, outcome: 'unknown' };
  if (!samePrincipal(message.from, principal))
    return { messageId: input.messageId, outcome: 'not-yours' };
  const resolved = loadAcks(m).get(message.id);
  if (resolved === 'cancelled') return { messageId: input.messageId, outcome: 'cancelled' };
  if (resolved === 'delivered' || !isConditional(message))
    return { messageId: input.messageId, outcome: 'delivered' };
  appendAck(m, message.id, 'cancel', message.to);
  return { messageId: input.messageId, outcome: 'cancelled' };
}
