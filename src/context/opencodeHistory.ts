import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { OpenCodeClient } from '../agent/opencode/server.ts';
import { OpenCodeToolFieldsSchema } from '../agent/opencode/toolObservation.ts';

const Id = z.string().min(1).max(256);
const MessageSchema = z.object({
  info: z.object({
    id: Id,
    sessionID: Id,
    role: z.enum(['user', 'assistant']),
    parentID: Id.optional(),
    summary: z.union([z.boolean(), z.object({}).strip()]).optional(),
    time: z.object({ completed: z.number().optional() }),
    error: z.unknown().optional(),
  }),
  parts: z
    .array(
      OpenCodeToolFieldsSchema.extend({
        id: Id,
        type: z.string(),
        text: z.string().optional(),
        filename: z.string().optional(),
        synthetic: z.boolean().optional(),
      }),
    )
    .max(256),
});
const PageSchema = z.array(MessageSchema).max(64);
const CursorSchema = z
  .object({
    next: z.string().min(1).max(4_096).nullable(),
    pending: z.array(z.tuple([Id, Id])).max(64),
  })
  .strict();
type Message = z.infer<typeof MessageSchema>;

function invalidCursor(): never {
  throw new AppError('HISTORY_CURSOR', 'Native history cursor is no longer current', 409);
}

function parseCursor(value: string): z.infer<typeof CursorSchema> {
  try {
    return CursorSchema.parse(JSON.parse(value));
  } catch {
    return invalidCursor();
  }
}

/** Native header cursors stay opaque. Pending parts carry only source identities, never text. */
export function openCodeHistoryReader(client: OpenCodeClient, sessionID: string) {
  const validate = (message: Message) => {
    if (message.info.sessionID !== sessionID) throw new Error('Native history identity mismatch');
    return message;
  };
  const messages = async (limit: number, signal: AbortSignal, before?: string) => {
    const response = await client.session.messages(
      { sessionID, limit, ...(before === undefined ? {} : { before }) },
      { signal },
    );
    const header = response.response.headers.get('X-Next-Cursor');
    return {
      items: PageSchema.parse(response.data).map(validate),
      cursor: header === null ? null : z.string().min(1).max(4_096).parse(header),
    };
  };
  return {
    messages,
    async parts(limit: number, signal: AbortSignal, cursor?: string) {
      const state = cursor === undefined ? undefined : parseCursor(cursor);
      let items: Message[] = [];
      let next = state?.next ?? null;
      const pending: z.infer<typeof CursorSchema>['pending'] = [];
      if (state !== undefined && state.pending.length > 0) {
        // At most eight simultaneous reads, all through the existing authenticated SDK client.
        let end = state.pending.length;
        let count = 0;
        while (end > 0 && count < limit) {
          signal.throwIfAborted();
          const start = Math.max(0, end - 8);
          const batch = await Promise.all(
            state.pending.slice(start, end).map(async ([messageId, throughPart]) => {
              const response = await client.session.message(
                { sessionID, messageID: messageId },
                { signal },
              );
              const message = validate(MessageSchema.parse(response.data));
              if (message.info.id !== messageId) return invalidCursor();
              const end = message.parts.findIndex((part) => part.id === throughPart);
              if (end < 0) return invalidCursor();
              return { ...message, parts: message.parts.slice(0, end + 1) };
            }),
          );
          items.unshift(...batch);
          count += batch.reduce((sum, message) => sum + message.parts.length, 0);
          end = start;
        }
        pending.push(...state.pending.slice(0, end));
      } else {
        if (state !== undefined && state.next === null) return invalidCursor();
        const page = await messages(limit, signal, state?.next ?? undefined);
        items = page.items;
        next = page.cursor;
      }
      // Deliver the newest parts; everything older remains addressable by exact native IDs.
      let remaining = Math.max(
        0,
        items.reduce((count, item) => count + item.parts.length, 0) - limit,
      );
      const selected: Message[] = [];
      for (const message of items) {
        const count = Math.min(remaining, message.parts.length);
        const through = message.parts[count - 1];
        if (through !== undefined) pending.push([message.info.id, through.id]);
        const parts = message.parts.slice(count);
        if (parts.length > 0) selected.push({ ...message, parts });
        remaining -= count;
      }
      return {
        items: selected,
        cursor:
          next === null && pending.length === 0
            ? null
            : JSON.stringify(CursorSchema.parse({ next, pending })),
      };
    },
  };
}
