import { z } from 'zod';
import { projectNativeRequest, publicRequestId } from '../agent/codex/ownedNative.ts';
import type { CodexRpcEvent, CodexRpcRequest } from '../agent/codex/rpc.ts';
import { CodexToolFieldsSchema, codexToolObservation } from '../agent/codex/toolObservation.ts';
import type { ContentBuffer } from './buffer.ts';

const Id = z.string().min(1).max(256);
const Delta = z.object({
  threadId: Id,
  turnId: Id,
  itemId: Id,
  delta: z.string().max(2 * 1024 * 1024),
  summaryIndex: z.number().int().nonnegative().optional(),
});
const Item = z.object({
  threadId: Id,
  turnId: Id,
  item: CodexToolFieldsSchema.extend({
    id: Id,
    text: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    summary: z
      .array(z.union([z.string(), z.object({ text: z.string() })]))
      .max(64)
      .optional(),
  }),
});
const Turn = z.object({
  threadId: Id,
  turn: z.object({ id: Id, status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']) }),
});
const Resolved = z.object({ threadId: Id, requestId: z.union([z.string(), z.number()]) });
const Usage = z.object({
  threadId: Id,
  turnId: Id,
  tokenUsage: z.object({
    total: z.object({
      totalTokens: z.number().nonnegative(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cachedInputTokens: z.number().nonnegative(),
      reasoningOutputTokens: z.number().nonnegative(),
    }),
  }),
});
export const CODEX_CONTENT_METHODS = new Set([
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/started',
  'item/completed',
  'turn/completed',
  'thread/tokenUsage/updated',
  'serverRequest/resolved',
]);

/** Only explicit public summaries are observed; reasoning text and tool payloads are not projected. */
export function observeCodexContent(
  buffer: ContentBuffer,
  threadId: string,
  event: CodexRpcEvent,
): void {
  if (
    event.method === 'item/agentMessage/delta' ||
    event.method === 'item/plan/delta' ||
    event.method === 'item/reasoning/summaryTextDelta'
  ) {
    const data = Delta.parse(event.params);
    if (data.threadId !== threadId) return;
    const summary = event.method === 'item/reasoning/summaryTextDelta';
    buffer.text(
      summary ? 'reasoning-summary' : 'assistant',
      data.turnId,
      summary ? `${data.itemId}:summary:${data.summaryIndex ?? 0}` : data.itemId,
      data.delta,
      'append',
    );
  } else if (event.method === 'item/started' || event.method === 'item/completed') {
    const data = Item.parse(event.params);
    if (data.threadId !== threadId) return;
    const complete = event.method === 'item/completed',
      item = data.item;
    if ((item.type === 'agentMessage' || item.type === 'plan') && item.text !== undefined)
      buffer.text('assistant', data.turnId, item.id, item.text, 'replace', complete);
    else if (item.type === 'reasoning' && item.summary !== undefined) {
      for (const [index, entry] of item.summary.entries())
        buffer.text(
          'reasoning-summary',
          data.turnId,
          `${item.id}:summary:${index}`,
          typeof entry === 'string' ? entry : entry.text,
          'replace',
          complete,
        );
    } else {
      const tool = codexToolObservation(item, complete ? 'completed' : 'started');
      if (tool) buffer.tool(data.turnId, item.id, tool);
    }
  } else if (event.method === 'turn/completed') {
    const data = Turn.parse(event.params);
    if (data.threadId === threadId)
      buffer.lifecycle('terminal', data.turn.id, data.turn.id, data.turn.status);
  } else if (event.method === 'serverRequest/resolved') {
    const data = Resolved.parse(event.params);
    if (data.threadId === threadId)
      buffer.lifecycle('request', null, publicRequestId(data.requestId), 'resolved');
  } else if (event.method === 'thread/tokenUsage/updated') {
    const data = Usage.parse(event.params);
    if (data.threadId === threadId)
      buffer.lifecycle(
        'usage',
        data.turnId,
        `${data.turnId}:usage`,
        'updated',
        JSON.stringify(data.tokenUsage.total),
      );
  }
}

export function observeCodexRequest(
  buffer: ContentBuffer,
  threadId: string,
  request: CodexRpcRequest,
): void {
  const pending = projectNativeRequest(request, threadId);
  if (pending) buffer.lifecycle('request', null, pending.requestId, 'requested', pending.kind);
}
