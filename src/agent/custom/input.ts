import type { AgentMessagePart } from 'stitchkit/agent-runtime';
import { z } from 'zod';
import { AttachmentReferencesSchema } from '../../attachments/reference.ts';
import type { RuntimeInput } from '../../runtime/input.ts';
import { NativeModelSelectionSchema } from '../../runtime/selectionSchema.ts';

export const CustomInputMetadataSchema = z
  .object({
    registration: z.uuid(),
    messageId: z.uuid(),
    recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    model: NativeModelSelectionSchema,
    images: AttachmentReferencesSchema.default([]),
    parentRunId: z.string().min(1).max(256).optional(),
    responseOperationId: z.uuid().optional(),
    responseFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type CustomInputMetadata = z.infer<typeof CustomInputMetadataSchema>;

/** Canonical history holds owner attachment identities, never paths or inline secret bytes. */
export function customInputParts(input: Pick<RuntimeInput, 'text' | 'images'>): AgentMessagePart[] {
  return [
    { type: 'text', text: input.text },
    ...(input.images ?? []).map(
      (image): AgentMessagePart => ({
        type: 'file',
        reference: image.id,
        mediaType: image.mediaType,
      }),
    ),
  ];
}
