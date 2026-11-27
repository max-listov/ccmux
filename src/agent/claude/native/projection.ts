import type { ExecutorDelta } from 'stitchkit/agent-executor';
import type { ClaudeRuntimeEvent, ClaudeSdkTurnUsage } from 'stitchkit/agent-executor/claude-sdk';
import type { ContentProducer } from '../../../content/producer.ts';
import type {
  NativeSnapshot,
  NativeUsage,
  PermissionMode,
} from '../../../runtime/projectionSchema.ts';
import { summarise } from './permission.ts';
import { composeSnapshot, type SnapshotIdentity } from './snapshot.ts';
import { advanceTurn, initialTurn, type TurnState } from './turn.ts';

/** Bounded so a long session cannot grow the published observation without limit. */
const MAX_ITEMS = 256;

/** Sum per-model additive turn deltas from `ClaudeSdkTurnUsage` into Stitchmux's `NativeUsage`. */
export function nativeUsageFromTurn(usage: ClaudeSdkTurnUsage): NativeUsage | null {
  const entries = Object.values(usage.modelUsageDelta ?? {});
  if (entries.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const model of entries) {
    inputTokens += model.inputTokens;
    outputTokens += model.outputTokens;
    cachedInputTokens += (model.cacheReadInputTokens ?? 0) + (model.cacheCreationInputTokens ?? 0);
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    // The SDK has no provider-reported reasoning count; its estimate is kept out of usage.
    reasoningOutputTokens: null,
    totalTokens: null,
  };
}

/**
 * Everything a native Claude session publishes about itself, projected from
 * `stitchkit/agent-executor/claude-sdk` deltas and callbacks.
 */
export class NativeProjection {
  content: ContentProducer | null = null;
  items: NativeSnapshot['nativeItems'] = [];
  sequence = 0;
  connected = false;
  turn: TurnState = initialTurn;
  turnId: string | null = null;
  turnStartedAt: string | null = null;
  /** Item ids per turn, so a text stream coalesces instead of one item per fragment. */
  textItem = new Map<string, number>();
  /** What the runtime is actually using, published so a reader never has to guess. */
  selection: NativeSnapshot['nativeSelection'] = null;
  /** The mode the next turn runs under, updated only when the runtime accepts it. */
  permissionMode: PermissionMode | undefined = 'default';
  /** The last context measurement the runtime gave, refreshed when a turn ends. */
  contextUsage: NativeSnapshot['contextUsage'];
  /** Which account this session runs on, asked once at startup. */
  account: NativeSnapshot['account'];
  /** How full the account's plan windows are, refreshed when a turn ends and on clock ticks. */
  planLimits: NativeSnapshot['planLimits'];
  /** The session's MCP servers and their connection status. */
  mcpServers: NativeSnapshot['mcpServers'];
  /** Cumulative spend, as reported by the runtime on `usage` deltas. */
  spend: NativeSnapshot['spend'];

  applyDelta(delta: ExecutorDelta): void {
    this.turn = advanceTurn(this.turn, { step: 'delta', delta });
    const turnId = this.turnId ?? delta.turnId;

    if (delta.type === 'text') {
      if (delta.text.length === 0) return;
      const itemId = `${turnId}:text`;
      this.content?.buffer.text('assistant', turnId, itemId, delta.text, 'append');
      this.content?.publish();
      const at = this.textItem.get(itemId);
      if (at === undefined) {
        this.textItem.set(
          itemId,
          this.appendItem({
            kind: 'assistant',
            stage: 'updated',
            nativeId: itemId,
            turnId,
            requestId: null,
            status: null,
            text: delta.text,
            tool: null,
            usage: null,
          }),
        );
        return;
      }
      const existing = this.items[at];
      if (existing)
        this.items[at] = { ...existing, text: `${existing.text ?? ''}${delta.text}`.slice(-8_192) };
      return;
    }

    if (delta.type === 'tool-call') {
      const name = delta.toolName.slice(0, 128);
      this.content?.buffer.tool(turnId, delta.callId, {
        callId: delta.callId,
        name,
        lifecycle: 'running',
        outcome: 'unknown',
        exitCode: null,
      });
      this.appendItem({
        kind: 'tool',
        stage: 'started',
        nativeId: delta.callId,
        turnId,
        requestId: null,
        status: 'running',
        text: summarise(delta.toolName, delta.input),
        tool: name,
        usage: null,
      });
      this.content?.publish();
      return;
    }

    if (delta.type === 'tool-result') {
      const name = delta.toolName.slice(0, 128);
      this.content?.buffer.tool(turnId, delta.callId, {
        callId: delta.callId,
        name,
        lifecycle: 'completed',
        outcome: delta.outcome === 'success' ? 'succeeded' : 'failed',
        exitCode: null,
      });
      this.appendItem({
        kind: 'tool',
        stage: 'completed',
        nativeId: delta.callId,
        turnId,
        requestId: null,
        status: 'completed',
        text: null,
        tool: name,
        usage: null,
      });
      this.content?.publish();
      return;
    }

    if (delta.type === 'usage') {
      if (delta.costUsd !== undefined && Number.isFinite(delta.costUsd) && delta.costUsd >= 0) {
        this.spend = {
          totalCostUsd: delta.costUsd,
          observedAt: new Date().toISOString(),
        };
      }
      return;
    }

    if (delta.type === 'window' && delta.reset === 'context') {
      this.content?.buffer.resetContext();
      this.content?.publish();
      return;
    }

    if (delta.type === 'turn-end') {
      const terminalStatus = delta.outcome === 'failed' ? 'failed' : 'completed';
      this.content?.buffer.lifecycle('terminal', turnId, `${turnId}:end`, terminalStatus);
      this.appendItem({
        kind: 'terminal',
        stage: 'completed',
        nativeId: `${turnId}:end`,
        turnId,
        requestId: null,
        status: terminalStatus,
        text: null,
        tool: null,
        usage: null,
      });
      this.content?.publish();
    }
  }

  /** Publish per-turn additive spend into the content stream from Stitchkit's `onTurnUsage`. */
  applyTurnUsage(usage: ClaudeSdkTurnUsage): void {
    const spent = nativeUsageFromTurn(usage);
    if (spent === null) return;
    const turnId = this.turnId ?? usage.turnId;
    this.content?.buffer.lifecycle(
      'usage',
      turnId,
      `${turnId}:usage`,
      'updated',
      JSON.stringify({ scope: 'run', ...spent }),
    );
    this.content?.publish();
  }

  /** Record non-delta subagent/tool progress runtime events from Stitchkit's `onEvent`. */
  applyRuntimeEvent(event: ClaudeRuntimeEvent): void {
    const turnId = this.turnId ?? 'unknown';
    if (event.type === 'tool_progress') {
      this.appendItem({
        kind: 'tool',
        stage: 'started',
        nativeId: event.toolUseId,
        turnId,
        requestId: null,
        status: 'running',
        text: event.toolName,
        tool: event.toolName.slice(0, 128),
        usage: null,
      });
      return;
    }
    if (event.type === 'task_started' || event.type === 'task_notification') {
      this.appendItem({
        kind: 'tool',
        stage: event.type === 'task_notification' ? 'completed' : 'started',
        nativeId: event.taskId,
        turnId,
        requestId: null,
        status: event.type === 'task_notification' ? event.status : 'running',
        text: event.type === 'task_notification' ? event.summary : event.description,
        tool: 'Task',
        usage: null,
      });
    }
  }

  appendItem(item: Omit<NativeSnapshot['nativeItems'][number], 'sequence' | 'at'>): number {
    this.sequence += 1;
    this.items.push({ ...item, sequence: this.sequence, at: new Date().toISOString() });
    if (this.items.length > MAX_ITEMS) {
      const dropped = this.items.length - MAX_ITEMS;
      this.items.splice(0, dropped);
      for (const [key, at] of this.textItem) {
        if (at < dropped) this.textItem.delete(key);
        else this.textItem.set(key, at - dropped);
      }
    }
    return this.items.length - 1;
  }

  /** The observation to publish now, from what has been collected and the requests still open. */
  snapshot(
    identity: SnapshotIdentity,
    pending: readonly NativeSnapshot['pendingRequests'][number][],
    fileCheckpoints: boolean,
  ): NativeSnapshot {
    return composeSnapshot({
      identity,
      sequence: this.sequence,
      connected: this.connected,
      turn: this.turn,
      turnId: this.turnId,
      turnStartedAt: this.turnStartedAt,
      items: this.items,
      pending,
      selection: this.selection,
      permissionMode: this.permissionMode,
      contextUsage: this.contextUsage,
      planLimits: this.planLimits,
      account: this.account,
      spend: this.spend,
      fileCheckpoints,
      mcpServers: this.mcpServers,
      now: Date.now(),
    });
  }
}
