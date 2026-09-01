import { z } from 'zod';

/**
 * One slash command a runtime offers.
 *
 * Kept apart from the catalog that reads and writes it: a control-plane schema travels into the
 * packed client, and a client has no filesystem — a schema living beside `node:path` drags it there.
 */
export const ControlCommandSchema = z
  .object({
    /** Without the leading slash, exactly as the runtime names it. */
    name: z.string().min(1).max(128),
    description: z.string().max(1_024),
    argumentHint: z.string().max(256),
    aliases: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();
export type ControlCommand = z.infer<typeof ControlCommandSchema>;
