import { z } from 'zod';
import { CommunicationAuthorizationSchema } from './communicationAuthorizationSchema.ts';
import { CommunicationReceiptSchema } from './communicationReceiptSchema.ts';
import { ChatPrincipalSchema, ChatTargetSchema } from './identitySchema.ts';
import { MessageOriginSchema, NotificationAudienceSchema } from './originSchema.ts';

/** Browser-safe wire data only. Labels do not establish author or notification authority. */
export const LogRowSchema = z.object({
  messageId: z.uuid().nullable(),
  sender: ChatPrincipalSchema.nullable(),
  target: ChatTargetSchema.nullable(),
  origin: MessageOriginSchema,
  communicationAuthorization: CommunicationAuthorizationSchema.optional().describe(
    'Unverified caller claim; absence means no evidence was recorded, not permission.',
  ),
  notification: NotificationAudienceSchema,
  communicationReceipt: CommunicationReceiptSchema.optional(),
  registrationGeneration: z.uuid().nullable(),
  machine: z.string(),
  ts: z.string(),
  kind: z.enum(['chat', 'sent']),
  from: z.string(),
  to: z.string(),
  task: z.string().nullable().default(null),
  body: z.string(),
  note: z.string().default(''),
});
export type LogRow = z.infer<typeof LogRowSchema>;
export const LogMachineSchema = z.object({
  machine: z.string(),
  ok: z.boolean().default(true),
  error: z.string().nullable().default(null),
});
export type LogMachine = z.infer<typeof LogMachineSchema>;
export const LogPayloadSchema = z.object({
  machines: z.array(LogMachineSchema).default([]),
  rows: z.array(LogRowSchema).default([]),
});
export type LogPayload = z.infer<typeof LogPayloadSchema>;
/**
 * The largest frame this feed will emit.
 *
 * Anchored to the transport rather than chosen by taste: the remote transport carries a stream in 32 KiB chunks,
 * so a record that fits inside one is never split across two, and a reader assembling lines never
 * has to hold a partial record across a chunk boundary. The cap is on the WHOLE frame, not on the
 * body alone — otherwise a long address or task name could still push a frame over while the field
 * everyone watches looked innocent.
 */
export const LOG_FRAME_MAX_BYTES = 32 * 1024;

/** The cursor is an opaque producer position; consumers return it unchanged. */
export const LogFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('row'), cursor: z.string(), row: LogRowSchema }).strict(),
  z.object({ kind: z.literal('machine'), cursor: z.string(), machine: LogMachineSchema }).strict(),
]);
export type LogFrame = z.infer<typeof LogFrameSchema>;
