import type { AgentRuntimeEvent } from 'stitchkit/agent-runtime';
import type { NativeItem } from '../../runtime/projectionSchema.ts';
import type { ManagedRuntimeSnapshot } from '../../runtime/schema.ts';

/** Rich text stays in the content lane. Status retains bounded causal categories and known counts. */
export function appendCustomMetadata(
  snapshot: ManagedRuntimeSnapshot,
  event: AgentRuntimeEvent,
): void {
  const push = (
    item: Pick<NativeItem, 'kind' | 'stage' | 'nativeId'> &
      Partial<Pick<NativeItem, 'status' | 'tool' | 'usage'>>,
  ) => {
    snapshot.nativeItems.push({
      requestId: null,
      status: null,
      text: null,
      tool: null,
      usage: null,
      ...item,
      sequence: ++snapshot.nativeSequence,
      at: event.emittedAt,
      turnId: event.runId,
    });
    if (snapshot.nativeItems.length > 128) snapshot.nativeItems.shift();
  };
  if (event.type === 'admission')
    push({ kind: 'user', stage: 'completed', nativeId: event.input.id });
  else if (event.type === 'tool-status')
    push({
      kind: 'tool',
      stage: event.status === 'started' ? 'started' : 'completed',
      nativeId: event.callId,
      status: event.status,
      tool: event.toolName.slice(0, 128),
    });
  else if (event.type === 'terminal') {
    push({ kind: 'terminal', stage: 'completed', nativeId: event.runId, status: event.reason });
    const usage = event.metrics?.usage;
    if (usage) {
      const input = usage.inputTokens.value ?? null,
        output = usage.outputTokens.value ?? null;
      push({
        kind: 'usage',
        stage: 'updated',
        nativeId: event.runId,
        usage: {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input === null || output === null ? null : input + output,
          cachedInputTokens: usage.cacheReadTokens?.value ?? null,
          reasoningOutputTokens: usage.reasoningTokens?.value ?? null,
        },
      });
    }
  }
}
