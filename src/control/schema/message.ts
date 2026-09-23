import { z } from 'zod';
import { AttachmentReferencesSchema } from '../../attachments/reference.ts';
import { CommunicationAuthorizationInputSchema } from '../../chat/communicationAuthorizationSchema.ts';
import { ManagedPeerSchema } from '../../chat/identitySchema.ts';
import {
  MessageAttributionSchema,
  MessageOriginSchema,
  NotificationAudienceSchema,
} from '../../chat/originSchema.ts';
import {
  AcceptedTurnOptionsSchema,
  NativeTurnOptionsSchema,
} from '../../runtime/selectionSchema.ts';
import { ControlTargetSchema } from './core.ts';

export const ControlMessageSchema = ControlTargetSchema.extend({
  communicationAuthorization: CommunicationAuthorizationInputSchema.nullable().describe(
    'Required basis: user-instruction (rationale, verbatim quote, sourceMessageRef), peer-letter (same fields, reference <peer thread uuid>#<message uuid>), or thread-continuation (sourceMessageRef only, same pair and task). References resolve on the originating host. Null is reserved for server-admitted human input. A claim is not a verified grant or file-transfer authority.',
  ),
  messageId: z.uuid(),
  origin: MessageAttributionSchema.optional(),
  notification: NotificationAudienceSchema.optional(),
  registrationGeneration: z.uuid().optional(),
  body: z.string().trim().max(16_384).default(''),
  images: AttachmentReferencesSchema.default([]),
  options: NativeTurnOptionsSchema.optional(),
  /**
   * Wait for the recipient's turn boundary. TRUE by default: typed input reaches a working agent as
   * steering — it lands inside the turn and redirects it — so a routine message would cut across
   * work nobody asked it to interrupt. Set false only to break in deliberately.
   */
  defer: z.boolean().default(true),
  notBefore: z.iso.datetime().nullable().default(null),
  task: z.string().max(256).nullable().default(null),
})
  .strict()
  // Attributed input must pin the exact registration it is addressing — but only a session that HAS
  // a generation can be pinned, and most do not: they are ordinary panes, not native runtimes. Asked
  // here, where the target is unknown, the requirement became "supply a value that does not exist",
  // and it closed the only route an application has for a human's message. It is asked in the
  // handler instead, which knows the session (see `acceptControlMessage`).
  .refine((value) => value.body.length > 0 || value.images.length > 0, 'Message input is empty');
export type ControlMessage = z.input<typeof ControlMessageSchema>;
export const ControlMessageReceiptSchema = z
  .object({
    messageId: z.uuid(),
    origin: MessageOriginSchema,
    notification: NotificationAudienceSchema,
    registrationGeneration: z.uuid().nullable(),
    accepted: z.literal(true),
    duplicate: z.boolean(),
    turnOptions: AcceptedTurnOptionsSchema.nullable(),
  })
  .strict();
/**
 * Take back a letter that was accepted but has not been delivered.
 *
 * The mechanism existed — a cancel tombstone in the ack log — and only the command line could reach
 * it, so a consumer could not withdraw what it had itself queued. Its "stop" button answered
 * "nothing to stop" while a letter sat waiting for a turn boundary, which is the wrong answer with
 * confidence.
 *
 * By id, and only the caller's own: cancelling a letter another party sent would be reaching into
 * someone else's conversation.
 */
export const ControlMessageCancelSchema = z.object({ messageId: z.uuid() }).strict();
export const ControlMessageCancelReceiptSchema = z
  .object({
    messageId: z.uuid(),
    /**
     * Four answers, kept apart because they call for different things from a caller.
     *
     * `cancelled` — it will not be delivered. `delivered` — too late, the recipient has it, and a
     * caller that renders this as "cancelled" is telling its user the opposite of what happened.
     * `undeliverable` — the recipient session no longer exists, so the letter was closed without
     * ever being received; reporting that as `delivered` would credit a letter nobody read.
     * `unknown` — no such letter on this machine. `not-yours` — it exists and belongs to someone
     * else; said plainly rather than disguised as `unknown`, which would make a permissions answer
     * look like a missing one.
     */
    outcome: z.enum(['cancelled', 'delivered', 'undeliverable', 'unknown', 'not-yours']),
  })
  .strict();

export const ControlInterruptSchema = ControlTargetSchema.extend({
  generation: z.uuid(),
  turnId: z.string().min(1).max(256),
}).strict();
export const ControlActionReceiptSchema = z
  .object({ target: ManagedPeerSchema, accepted: z.literal(true) })
  .strict();
