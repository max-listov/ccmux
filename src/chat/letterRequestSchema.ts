import { z } from 'zod';
import { CommunicationAuthorizationInputSchema } from './communicationAuthorizationSchema.ts';
import { AgentKindSchema } from './identitySchema.ts';

/**
 * One letter, as `ccmux msg` and the `letter.send` operation both ask for it.
 *
 * The command reads its flags into this; a program sends it as the operation's input. Both reach
 * `sendLetter`, so the two roads cannot differ in who may send, where a name resolves, or what the
 * receipt says.
 */
export const LetterRequestSchema = z
  .object({
    /** A session (`name`, `machine:name`, a role), an App thread, `owner`, or an owner outside the fleet. */
    to: z.string().min(1).max(512),
    body: z
      .string()
      .min(1)
      .max(1024 * 1024),
    task: z.string().min(1).max(512).nullable().default(null),
    /** Break into a running turn instead of waiting for its boundary. */
    interrupt: z.boolean().default(false),
    /** A router session sending for another party. */
    onBehalfOf: z.string().min(1).max(512).nullable().default(null),
    /** Seconds until the letter comes due; a timed letter is this machine's to deliver. */
    afterSeconds: z
      .int()
      .min(1)
      .max(30 * 24 * 3600)
      .nullable()
      .default(null),
    /** The recipient must be this provider's session. */
    toAgent: AgentKindSchema.nullable().default(null),
    /** The recipient must be this exact conversation. */
    toThread: z.uuid().nullable().default(null),
    communicationAuthorization: CommunicationAuthorizationInputSchema.optional(),
  })
  .strict();
export type LetterRequest = z.output<typeof LetterRequestSchema>;
