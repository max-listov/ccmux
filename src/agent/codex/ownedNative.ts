import { z } from 'zod';
import type { OwnedCodexNativeItem, OwnedCodexPendingRequest } from './ownedSchema.ts';
import type { CodexRpcEvent, CodexRpcRequest } from './rpc.ts';

const ItemEvent = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z
    .object({
      id: z.string(),
      type: z.string(),
      status: z.string().optional(),
      text: z.string().optional(),
      summary: z.array(z.string()).optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .passthrough(),
});
const UsageEvent = z.object({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.object({
    total: z.object({
      totalTokens: z.number(),
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
      reasoningOutputTokens: z.number(),
    }),
  }),
});
const TurnEvent = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string() }),
});
const ApprovalRequest = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  reason: z.string().nullable().optional(),
  startedAtMs: z.number().optional(),
  availableDecisions: z.array(z.unknown()).optional(),
});
const InputRequest = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        header: z.string(),
        question: z.string(),
        isOther: z.boolean(),
        isSecret: z.boolean(),
        options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
      }),
    )
    .max(3),
});
const ResolvedEvent = z.object({
  threadId: z.string(),
  requestId: z.union([z.number(), z.string()]),
});

const clip = (value: string | undefined | null, max: number): string | null =>
  value == null ? null : value.slice(0, max);
export const publicRequestId = (id: number | string): string =>
  `${typeof id === 'number' ? 'n' : 's'}:${String(id)}`.slice(0, 256);

export function projectNativeEvent(
  event: CodexRpcEvent,
  threadId: string,
  sequence: number,
  now = Date.now(),
): OwnedCodexNativeItem | null {
  const base = { sequence, at: new Date(now).toISOString(), requestId: null, usage: null };
  if (event.method === 'item/started' || event.method === 'item/completed') {
    const parsed = ItemEvent.safeParse(event.params);
    if (!parsed.success || parsed.data.threadId !== threadId) return null;
    const { item, turnId } = parsed.data;
    const stage = event.method === 'item/started' ? ('started' as const) : ('completed' as const);
    if (item.type === 'userMessage')
      return {
        ...base,
        kind: 'user',
        stage,
        nativeId: item.id,
        turnId,
        status: item.status ?? null,
        text: clip(
          item.content
            ?.filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n'),
          2_048,
        ),
        tool: null,
      };
    if (item.type === 'agentMessage')
      return {
        ...base,
        kind: 'assistant',
        stage,
        nativeId: item.id,
        turnId,
        status: item.status ?? null,
        text: clip(item.text, 2_048),
        tool: null,
      };
    if (item.type === 'reasoning' || item.type === 'plan')
      return {
        ...base,
        kind: 'reasoning',
        stage,
        nativeId: item.id,
        turnId,
        status: item.status ?? null,
        text: clip(item.text ?? item.summary?.join('\n'), 2_048),
        tool: null,
      };
    return {
      ...base,
      kind: 'tool',
      stage,
      nativeId: item.id,
      turnId,
      status: item.status ?? null,
      text: null,
      tool: clip(item.type, 128),
    };
  }
  if (event.method === 'thread/tokenUsage/updated') {
    const parsed = UsageEvent.safeParse(event.params);
    if (!parsed.success || parsed.data.threadId !== threadId) return null;
    const total = parsed.data.tokenUsage.total;
    return {
      ...base,
      kind: 'usage',
      stage: 'updated',
      nativeId: parsed.data.turnId,
      turnId: parsed.data.turnId,
      status: null,
      text: null,
      tool: null,
      usage: {
        totalTokens: total.totalTokens,
        inputTokens: total.inputTokens,
        cachedInputTokens: total.cachedInputTokens,
        outputTokens: total.outputTokens,
        reasoningOutputTokens: total.reasoningOutputTokens,
      },
    };
  }
  if (event.method === 'turn/completed') {
    const parsed = TurnEvent.safeParse(event.params);
    if (!parsed.success || parsed.data.threadId !== threadId) return null;
    return {
      ...base,
      kind: 'terminal',
      stage: 'completed',
      nativeId: parsed.data.turn.id,
      turnId: parsed.data.turn.id,
      status: parsed.data.turn.status.slice(0, 64),
      text: null,
      tool: null,
    };
  }
  return null;
}

export function projectNativeRequest(
  request: CodexRpcRequest,
  threadId: string,
  now = Date.now(),
): OwnedCodexPendingRequest | null {
  if (
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval'
  ) {
    const parsed = ApprovalRequest.safeParse(request.params);
    if (!parsed.success || parsed.data.threadId !== threadId) return null;
    const advertised = new Set(
      parsed.data.availableDecisions?.filter(
        (value): value is string => typeof value === 'string',
      ) ?? [],
    );
    const decisions = (['accept', 'acceptForSession', 'decline', 'cancel'] as const).filter(
      (value) => advertised.size === 0 || advertised.has(value),
    );
    return {
      requestId: publicRequestId(request.id),
      rpcId: request.id,
      kind: 'approval',
      approvalKind: request.method.includes('commandExecution') ? 'command' : 'file',
      turnId: parsed.data.turnId,
      itemId: parsed.data.itemId,
      reason: clip(parsed.data.reason, 2_048),
      scope: null,
      decisions: [...decisions],
      questions: [],
      requestedAt: new Date(parsed.data.startedAtMs ?? now).toISOString(),
    };
  }
  if (request.method === 'item/tool/requestUserInput') {
    const parsed = InputRequest.safeParse(request.params);
    if (!parsed.success || parsed.data.threadId !== threadId) return null;
    return {
      requestId: publicRequestId(request.id),
      rpcId: request.id,
      kind: 'input',
      approvalKind: null,
      turnId: parsed.data.turnId,
      itemId: parsed.data.itemId,
      reason: null,
      scope: null,
      decisions: [],
      questions: parsed.data.questions.map((question) => ({
        ...question,
        header: question.header.slice(0, 128),
        question: question.question.slice(0, 1_024),
        options:
          question.options?.slice(0, 8).map((option) => ({
            label: option.label.slice(0, 128),
            description: option.description.slice(0, 256),
          })) ?? null,
      })),
      requestedAt: new Date(now).toISOString(),
    };
  }
  return null;
}

export function resolvedRequestId(event: CodexRpcEvent, threadId: string): string | null {
  if (event.method !== 'serverRequest/resolved') return null;
  const parsed = ResolvedEvent.safeParse(event.params);
  return parsed.success && parsed.data.threadId === threadId
    ? publicRequestId(parsed.data.requestId)
    : null;
}
