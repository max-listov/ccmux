import { rec } from '../transcript/normalize.ts';

/**
 * What a person or the runtime queued while a turn was running.
 *
 * A prompt that arrives mid-turn is not written as a `user` entry: it is an `attachment` whose
 * `queued_command` carries the text (or content blocks) and the time. The runtime's own queued
 * words — the notice that a background task ended — take the same shape. Read as nothing, a
 * person's mid-turn message was missing from the conversation it was said in.
 */
export function queuedCommand(entry: Record<string, unknown>): unknown[] | null {
  if (entry.type !== 'attachment') return null;
  const attachment = rec(entry.attachment);
  if (attachment?.type !== 'queued_command') return null;
  const prompt = attachment.prompt;
  if (Array.isArray(prompt)) return prompt;
  return typeof prompt === 'string' && prompt !== '' ? [{ type: 'text', text: prompt }] : [];
}

/** The native message's original block positions, independent of the displayed window. */
export function contentItems(entry: Record<string, unknown>): unknown[] {
  // A copy of what was sent to the model, kept by hash and without a time. Everything in it is
  // already in the conversation as its own dated entry; read as a message it said every line twice,
  // the second time undated.
  if (entry.type === 'api-request-blob') return [];
  const queued = queuedCommand(entry);
  if (queued !== null) return queued;
  const content = rec(entry.message)?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}
