import { z } from 'zod';
import type { OwnedCodexRead, OwnedCodexSnapshot } from './ownedSchema.ts';

export const CodexRuntimeCursorSchema = z
  .object({ generation: z.uuid(), sequence: z.number().int().nonnegative() })
  .strict();
export type CodexRuntimeCursor = z.infer<typeof CodexRuntimeCursorSchema>;

/** Each bounded snapshot is a baseline plus an event window. A gap requires baseline replacement. */
export function codexRuntimeUpdates(
  read: OwnedCodexRead,
  cursor?: CodexRuntimeCursor,
): {
  read: OwnedCodexRead;
  cursor: CodexRuntimeCursor | null;
  reset: 'unavailable' | 'initial' | 'generation' | 'gap' | null;
  events: OwnedCodexSnapshot['events'];
} {
  const snapshot = read.snapshot;
  if (read.status !== 'live' || snapshot === null)
    return { read, cursor: null, reset: 'unavailable', events: [] };
  const next = { generation: snapshot.generation, sequence: snapshot.sequence };
  const reset =
    cursor === undefined
      ? 'initial'
      : cursor.generation !== next.generation
        ? 'generation'
        : cursor.sequence > snapshot.sequence ||
            (snapshot.events[0]?.sequence ?? snapshot.sequence + 1) > cursor.sequence + 1
          ? 'gap'
          : null;
  return {
    read,
    cursor: next,
    reset,
    events:
      reset === null
        ? snapshot.events.filter((event) => event.sequence > (cursor?.sequence ?? 0))
        : [],
  };
}
