import { rec } from '../transcript/normalize.ts';

/** The native message's original block positions, independent of the displayed window. */
export function contentItems(entry: Record<string, unknown>): unknown[] {
  const content = rec(entry.message)?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}
