import { z } from 'zod';

/** What a caller asks the reads of identity, messages and letters with. */

export const IdentityWhoisReadSchema = z
  .object({
    /** A window or pane title, an address, or the id a provider gave a conversation. */
    query: z.string().min(1).max(1024),
    /** Only this machine's sessions; otherwise every machine of the fleet is asked. */
    local: z.boolean().default(false),
  })
  .strict();

export const IdentityListReadSchema = z.object({ local: z.boolean().default(false) }).strict();

export const ExactMessageReadSchema = z
  .object({
    /** The session's address on this machine. */
    address: z.string().min(1).max(256),
    /** The provider's record id, or the id a window read names the message by. */
    messageId: z.string().min(1).max(256),
  })
  .strict();

export const ChatLogReadSchema = z
  .object({
    /** The newest rows kept, across every machine asked. */
    limit: z.int().min(1).max(1000).default(30),
    /** Merge every other machine's log in; otherwise only this machine's. */
    fleet: z.boolean().default(false),
  })
  .strict();

export const SentLettersReadSchema = z
  .object({ task: z.string().min(1).max(256).nullable().default(null) })
  .strict();
