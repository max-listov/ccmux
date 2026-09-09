import { z } from 'zod';
import { CommunicationAuthorizationSchema } from './communicationAuthorizationSchema.ts';
import { ChatPrincipalSchema, ChatTargetSchema } from './identitySchema.ts';

/** A local record snapshot is evidence of a claim, not proof of human consent. */
export const CommunicationReceiptSchema = z
  .object({
    rootMessageId: z.uuid(),
    authorization: CommunicationAuthorizationSchema.refine(
      (value) => value.basis === 'user-instruction' || value.basis === 'peer-letter',
      'The root must state an opening basis',
    ),
    sourceLetter: z
      .object({
        id: z.uuid(),
        ts: z.string(),
        from: ChatPrincipalSchema,
        to: ChatTargetSchema,
        task: z.string().nullable(),
        body: z.string().max(16_384),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CommunicationReceipt = z.infer<typeof CommunicationReceiptSchema>;
