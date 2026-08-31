import { z } from 'zod';
import { ChatPrincipalSchema, ChatTargetSchema } from './identitySchema.ts';
import { MessageOriginSchema, NotificationAudienceSchema } from './originSchema.ts';

/** Browser-safe wire data only. Labels do not establish author or notification authority. */
export const LogRowSchema = z.object({
  messageId: z.uuid().nullable(),
  sender: ChatPrincipalSchema.nullable(),
  target: ChatTargetSchema.nullable(),
  origin: MessageOriginSchema,
  notification: NotificationAudienceSchema,
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
/** The cursor is an opaque producer position; consumers return it unchanged. */
export const LogFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('row'), cursor: z.string(), row: LogRowSchema }).strict(),
  z.object({ kind: z.literal('machine'), cursor: z.string(), machine: LogMachineSchema }).strict(),
]);
export type LogFrame = z.infer<typeof LogFrameSchema>;
