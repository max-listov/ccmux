import { z } from 'zod';
import { MessageSenderSchema } from './messageSenderSchema.ts';

/** The answer of one message read whole by its id — what `exactMessage.ts` returns. */
export const EXACT_MESSAGE_LIMITS = {
  /** The message text is returned whole or not at all; past this it is `too-large`. */
  textBytes: 256 * 1024,
};

/**
 * `resolved`: the exact message, whole. `not-found`: the conversation has no record with that id.
 * `not-user-input`: the id names something that is not a user message — the agent's answer, a tool
 * call. `ambiguous`: the record holds several user messages; name one by its full id. `too-large`:
 * the text exceeds the bound and is not returned cut. `unsupported`: this session's runtime keeps
 * no history file to read a record from. `unavailable`: the history could not be read.
 */
export const ExactMessageOutcomeSchema = z.enum([
  'resolved',
  'not-found',
  'not-user-input',
  'ambiguous',
  'too-large',
  'unsupported',
  'unavailable',
]);

export const ExactMessageResultSchema = z
  .object({
    target: z.string().min(1),
    messageId: z.string().min(1),
    outcome: ExactMessageOutcomeSchema,
    observedAt: z.iso.datetime(),
    message: z
      .object({
        /** The id a window read gives this message: the record's id and the part of it. */
        id: z.string().min(1),
        seq: z.int().positive(),
        recordedAt: z.string().nullable(),
        /** The whole text, nothing cut and nothing added. */
        text: z.string(),
        sender: MessageSenderSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ExactMessageResult = z.infer<typeof ExactMessageResultSchema>;
