import { resolveMessageAttachments } from '../../../attachments/pins.ts';
import type { MachineConfig, Session } from '../../../types.ts';

/**
 * A turn's content: its text, and any images the caller pinned to the message.
 *
 * Resolved at dispatch rather than earlier because the bytes are owner-only — a data URL must never
 * reach a receipt or a status file. An image that cannot be resolved fails the turn instead of
 * being dropped: the caller attached it deliberately, and answering without it would answer a
 * different question than the one asked.
 */
export async function turnContent(
  m: MachineConfig,
  session: Session,
  input: { text: string; images?: readonly unknown[] | undefined; messageId: string },
) {
  const references = input.images ?? [];
  if (references.length === 0) return input.text;
  const resolved = await resolveMessageAttachments(
    m,
    session,
    input.messageId,
    references as never,
    AbortSignal.timeout(10_000),
    'data-url',
  );
  // Resolution returning FEWER images than were attached is the silent-loss case, not a smaller
  // turn. Checked before the shape of any single image, because the count is what goes missing
  // when a pin is absent.
  if (resolved.length !== references.length)
    throw new Error(
      `Attached images are not retained: ${references.length} sent, ${resolved.length} resolved`,
    );
  const images = resolved.map((item) => {
    const match = /^data:([^;]+);base64,(.*)$/.exec(item.dataUrl ?? '');
    if (!match?.[1] || !match[2]) throw new Error('Attached image is not retained');
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: match[1], data: match[2] },
    };
  });
  // Images first, then the text that refers to them — the order a person writes them in.
  return [...images, { type: 'text' as const, text: input.text }];
}
