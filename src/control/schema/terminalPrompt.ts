import { z } from 'zod';
import { ManagedPeerSchema } from '../../chat/identitySchema.ts';

export const TerminalMenuSchema = z
  .object({
    kind: z.enum([
      'folder-trust',
      'declared-permissions',
      'resume-picker',
      'external-imports',
      'unrecognised',
    ]),
    title: z.string().max(256),
    options: z
      .array(z.object({ id: z.string().max(64), label: z.string().max(256) }).strict())
      .max(20),
    selected: z.int().min(0).max(19).nullable(),
  })
  .strict();
export const TerminalPromptReadSchema = z.object({ target: ManagedPeerSchema }).strict();
export const TerminalPromptResultSchema = z
  .object({
    target: ManagedPeerSchema,
    observationId: z.uuid().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    menu: TerminalMenuSchema.nullable(),
  })
  .strict();
export const TerminalPromptRespondSchema = z
  .object({
    target: ManagedPeerSchema,
    observationId: z.uuid(),
    optionId: z.string().min(1).max(64),
  })
  .strict();
export const TerminalPromptReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    observationId: z.uuid(),
    optionId: z.string(),
    outcome: z.literal('submitted'),
  })
  .strict();
