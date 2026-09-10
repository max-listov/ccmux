import { z } from 'zod';
import {
  type ExternalContentEntry,
  type ExternalContentTarget,
  EXTERNAL_CONTENT_LIMITS as limits,
} from './contentSchema.ts';

const TextSchema = z.object({
  type: z.enum(['text', 'input_text', 'output_text']),
  text: z.string(),
});
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.unknown())]),
});
const CodexMessageSchema = MessageSchema.extend({ type: z.literal('message') });
const RecordSchema = z.object({
  type: z.string().optional(),
  sessionId: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  payload: z.unknown().optional(),
  message: z.unknown().optional(),
});

export function projectContent(
  raw: string,
  target: ExternalContentTarget,
  offset: number,
): ExternalContentEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RecordSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.isMeta || record.isCompactSummary) return null;
  if (target.provider === 'claude' && record.sessionId !== target.threadId) return null;
  if (target.provider === 'codex' && record.type !== 'response_item') return null;
  const message =
    target.provider === 'codex'
      ? CodexMessageSchema.safeParse(record.payload)
      : MessageSchema.safeParse(record.message);
  if (!message.success) return null;
  const text =
    typeof message.data.content === 'string'
      ? message.data.content
      : message.data.content
          .flatMap((part) => {
            const item = TextSchema.safeParse(part);
            return item.success ? [item.data.text] : [];
          })
          .join('\n');
  if (!text) return null;
  return {
    id: String(offset),
    role: message.data.role,
    // Own bounded text storage rather than retaining a substring of a large native record.
    text: Buffer.from(text.slice(0, limits.textCharacters), 'utf16le').toString('utf16le'),
    truncated: text.length > limits.textCharacters,
  };
}
