import type { AgentHistoryProjectionOptions } from 'stitchkit/agent-runtime';
import { resolveMessageAttachments } from '../../attachments/pins.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { CustomInputMetadataSchema } from './input.ts';

export function customImageResolver(
  m: MachineConfig,
  session: Session,
): NonNullable<AgentHistoryProjectionOptions['resolveFile']> {
  return async (part, message) => {
    const data = CustomInputMetadataSchema.parse(message.metadata);
    if (
      message.conversationId !== session.nativeSession?.id ||
      data.registration !== session.registrationGeneration ||
      data.recipeDigest !== session.launchRecipe?.digest ||
      message.role !== 'user'
    )
      throw new Error('Custom attachment does not belong to this conversation');
    const signal = AbortSignal.timeout(5000);
    const images = await resolveMessageAttachments(
      m,
      session,
      data.messageId,
      data.images,
      signal,
      'data-url',
    );
    const image = images.find(
      ({ reference }) => reference.id === part.reference && reference.mediaType === part.mediaType,
    );
    if (!image?.dataUrl) throw new Error('Custom attachment is not retained');
    return image.dataUrl;
  };
}
