import type { ExecutorDelta } from 'stitchkit/agent-executor';
import type { ContentBuffer } from '../../content/buffer.ts';
import {
  NATIVE_RUNTIME_MAX_EVENTS,
  NATIVE_RUNTIME_MAX_NATIVE_ITEMS,
  NATIVE_RUNTIME_TTL_MS,
  type NativePendingRequest,
  type NativeSnapshot,
  type PermissionMode,
} from '../../runtime/projectionSchema.ts';
import { type ManagedRuntimeSnapshot, ManagedRuntimeSnapshotSchema } from '../../runtime/schema.ts';
import type { NativeModelSelection } from '../../runtime/selectionSchema.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { VERSION } from '../../util/version.ts';

/**
 * Pure projection of `stitchkit/agent-executor/acp` deltas onto CCMux's unified native snapshot
 * and bounded live content buffer.
 */
export class AntigravityProjection {
  private value: ManagedRuntimeSnapshot;
  private textItems = new Map<string, number>();

  constructor(
    m: MachineConfig,
    session: Session,
    private content: ContentBuffer,
    generation: string,
    providerPid = process.pid,
  ) {
    const at = new Date().toISOString();
    this.value = {
      protocol: 1,
      provider: 'antigravity',
      machine: m.rcPrefix,
      session: session.name,
      threadId: session.uuid,
      generation,
      registrationGeneration: session.registrationGeneration,
      nativeSession: session.nativeSession,
      nativeSelection: null,
      permissionMode: 'default',
      sequence: 0,
      pid: process.pid,
      providerPid,
      version: VERSION,
      connected: false,
      state: 'unknown',
      reason: 'starting',
      observedAt: at,
      expiresAt: at,
      turn: null,
      events: [],
      nativeSequence: 0,
      nativeItems: [],
      pendingRequests: [],
    };
  }

  snapshot(): ManagedRuntimeSnapshot {
    return ManagedRuntimeSnapshotSchema.parse(structuredClone(this.value));
  }

  setNativeSession(nativeSession: NonNullable<Session['nativeSession']>): void {
    this.value.nativeSession = nativeSession;
  }

  setSelection(
    model: NativeModelSelection,
    effort: string | undefined,
    source: 'admission' | 'settings',
    turnId: string | null,
  ): void {
    this.value.nativeSelection = {
      model,
      options: {
        runtime: 'antigravity',
        model,
        ...(effort === undefined ? {} : { effort }),
      },
      source,
      turnId,
    };
  }

  setPermissionMode(mode: PermissionMode): void {
    this.value.permissionMode = mode;
  }

  ready(): void {
    this.value.connected = true;
    this.value.reason = null;
    this.syncState();
    this.touch();
  }

  unavailable(reason: string): void {
    this.value.connected = false;
    this.value.state = 'unknown';
    this.value.reason = reason;
    this.value.pendingRequests = [];
    this.touch('unavailable');
  }

  startTurn(turnId: string, startedAt: string): void {
    this.value.turn = { id: turnId, status: 'inProgress', startedAt };
    this.syncState();
    this.touch('turn-start');
  }

  failTurn(turnId: string, status: 'failed' | 'interrupted'): void {
    this.value.turn = {
      id: turnId,
      status,
      startedAt: this.value.turn?.startedAt ?? new Date().toISOString(),
    };
    this.value.pendingRequests = [];
    this.content.lifecycle('terminal', turnId, `${turnId}:end`, status);
    this.syncState();
    this.touch('turn-end');
  }

  /** Apply one normalized delta emitted by `stitchkit/agent-executor/acp`. */
  applyDelta(delta: ExecutorDelta): void {
    switch (delta.type) {
      case 'text': {
        const itemId = `${delta.turnId}:${delta.itemId}`;
        this.content.text('assistant', delta.turnId, itemId, delta.text, 'append');
        this.appendTextItem('assistant', delta.turnId, itemId, delta.text);
        return;
      }
      case 'reasoning': {
        const itemId = `${delta.turnId}:${delta.itemId}`;
        this.content.text('reasoning-summary', delta.turnId, itemId, delta.text, 'append');
        this.appendTextItem('reasoning', delta.turnId, itemId, delta.text);
        return;
      }
      case 'tool-call': {
        this.content.tool(delta.turnId, delta.callId, {
          callId: delta.callId,
          name: delta.toolName.slice(0, 128),
          lifecycle: 'running',
          outcome: 'unknown',
          exitCode: null,
        });
        this.appendItem({
          kind: 'tool',
          stage: 'started',
          nativeId: delta.callId.slice(0, 256),
          turnId: delta.turnId,
          requestId: null,
          status: 'running',
          text: null,
          tool: delta.toolName.slice(0, 128),
          usage: null,
        });
        this.touch();
        return;
      }
      case 'tool-result': {
        const outcome =
          delta.outcome === 'success'
            ? 'succeeded'
            : delta.outcome === 'interrupted'
              ? 'interrupted'
              : 'failed';
        this.content.tool(delta.turnId, delta.callId, {
          callId: delta.callId,
          name: delta.toolName.slice(0, 128),
          lifecycle: 'completed',
          outcome,
          exitCode: null,
        });
        this.appendItem({
          kind: 'tool',
          stage: 'completed',
          nativeId: delta.callId.slice(0, 256),
          turnId: delta.turnId,
          requestId: null,
          status: 'completed',
          text: null,
          tool: delta.toolName.slice(0, 128),
          usage: null,
        });
        this.touch();
        return;
      }
      case 'request': {
        const request: NativePendingRequest = {
          requestId: delta.interactionId,
          rpcId: delta.interactionId,
          kind: delta.kind,
          approvalKind: delta.kind === 'approval' ? 'tool' : null,
          turnId: delta.turnId,
          itemId: (delta.callId ?? delta.itemId).slice(0, 256),
          reason: (
            delta.prompt ??
            (delta.toolName ? `Permission required: ${delta.toolName}` : 'Permission required')
          ).slice(0, 2_048),
          scope: null,
          decisions: ['accept', 'decline'],
          questions: [],
          requestedAt: new Date().toISOString(),
        };
        if (this.value.pendingRequests.length < 16) {
          this.value.pendingRequests = [
            ...this.value.pendingRequests.filter((item) => item.requestId !== request.requestId),
            request,
          ];
        }
        this.content.lifecycle(
          'request',
          delta.turnId,
          request.requestId,
          'requested',
          request.reason,
        );
        this.syncState();
        this.touch();
        return;
      }
      case 'request-resolved': {
        this.value.pendingRequests = this.value.pendingRequests.filter(
          (item) => item.requestId !== delta.interactionId,
        );
        this.content.lifecycle('request', delta.turnId, delta.interactionId, 'resolved');
        this.syncState();
        this.touch();
        return;
      }
      case 'usage': {
        const input = delta.inputTokens ?? null;
        const output = delta.outputTokens ?? null;
        const body = {
          scope: 'run',
          totalTokens: input === null || output === null ? null : input + output,
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: delta.cachedInputTokens ?? null,
          reasoningOutputTokens: null,
          ...(delta.costUsd === undefined ? {} : { costValue: delta.costUsd, costCurrency: 'USD' }),
        };
        this.content.lifecycle(
          'usage',
          delta.turnId,
          `${delta.turnId}:usage`,
          'updated',
          JSON.stringify(body),
        );
        this.appendItem({
          kind: 'usage',
          stage: 'updated',
          nativeId: `${delta.turnId}:usage`,
          turnId: delta.turnId,
          requestId: null,
          status: 'updated',
          text: null,
          tool: null,
          usage: {
            totalTokens: body.totalTokens,
            inputTokens: input,
            cachedInputTokens: body.cachedInputTokens,
            outputTokens: output,
            reasoningOutputTokens: null,
          },
        });
        this.touch();
        return;
      }
      case 'context-usage': {
        if (delta.windowTokens > 0) {
          const percent = Math.min(
            100,
            Math.round((delta.usedTokens / delta.windowTokens) * 1000) / 10,
          );
          this.value.contextUsage = {
            usedTokens: delta.usedTokens,
            limitTokens: delta.windowTokens,
            rawLimitTokens: delta.windowTokens,
            percent,
            window: 'model-limit',
            observedAt: new Date().toISOString(),
          };
          this.touch();
        }
        return;
      }
      case 'turn-end': {
        this.value.turn = {
          id: delta.turnId,
          status: delta.outcome,
          startedAt: this.value.turn?.startedAt ?? new Date().toISOString(),
        };
        this.value.pendingRequests = [];
        this.content.lifecycle('terminal', delta.turnId, `${delta.turnId}:end`, delta.outcome);
        this.appendItem({
          kind: 'terminal',
          stage: 'completed',
          nativeId: `${delta.turnId}:end`,
          turnId: delta.turnId,
          requestId: null,
          status: delta.outcome,
          text: null,
          tool: null,
          usage: null,
        });
        this.syncState();
        this.touch('turn-end');
        return;
      }
      case 'error': {
        if (delta.kind !== 'unhandled') {
          this.value.reason = `${delta.kind}: ${delta.message}`.slice(0, 256);
        }
        this.touch();
        return;
      }
      case 'window':
        return;
    }
  }

  pendingRequest(requestId: string): NativePendingRequest | null {
    return this.value.pendingRequests.find((item) => item.requestId === requestId) ?? null;
  }

  resolvePending(requestId: string, decision: string): void {
    const existing = this.pendingRequest(requestId);
    this.value.pendingRequests = this.value.pendingRequests.filter(
      (item) => item.requestId !== requestId,
    );
    if (existing !== null) {
      this.content.lifecycle('request', existing.turnId, requestId, decision);
    }
    this.syncState();
    this.touch();
  }

  touch(kind: ManagedRuntimeSnapshot['events'][number]['kind'] = 'state'): void {
    const now = Date.now();
    this.value.observedAt = new Date(now).toISOString();
    this.value.expiresAt = new Date(now + NATIVE_RUNTIME_TTL_MS).toISOString();
    this.value.events.push({
      sequence: ++this.value.sequence,
      at: this.value.observedAt,
      kind,
      state: this.value.state,
      turn: this.value.turn === null ? null : { ...this.value.turn },
    });
    if (this.value.events.length > NATIVE_RUNTIME_MAX_EVENTS) this.value.events.shift();
  }

  private syncState(): void {
    if (!this.value.connected) {
      this.value.state = 'unknown';
      return;
    }
    const waiting = this.value.pendingRequests[0];
    if (waiting !== undefined) {
      this.value.state = waiting.kind === 'input' ? 'waiting-input' : 'waiting-approval';
      return;
    }
    this.value.state = this.value.turn?.status === 'inProgress' ? 'working' : 'idle';
  }

  private appendTextItem(
    kind: 'assistant' | 'reasoning',
    turnId: string,
    itemId: string,
    text: string,
  ): void {
    const index = this.textItems.get(itemId);
    if (index === undefined) {
      this.textItems.set(
        itemId,
        this.appendItem({
          kind,
          stage: 'updated',
          nativeId: itemId.slice(0, 256),
          turnId,
          requestId: null,
          status: null,
          text: text.slice(-8_192),
          tool: null,
          usage: null,
        }),
      );
      return;
    }
    const existing = this.value.nativeItems[index];
    if (existing) {
      this.value.nativeItems[index] = {
        ...existing,
        text: `${existing.text ?? ''}${text}`.slice(-8_192),
      };
    }
  }

  private appendItem(item: Omit<NativeSnapshot['nativeItems'][number], 'sequence' | 'at'>): number {
    this.value.nativeSequence += 1;
    this.value.nativeItems.push({
      ...item,
      sequence: this.value.nativeSequence,
      at: new Date().toISOString(),
    });
    if (this.value.nativeItems.length > NATIVE_RUNTIME_MAX_NATIVE_ITEMS) {
      const dropped = this.value.nativeItems.length - NATIVE_RUNTIME_MAX_NATIVE_ITEMS;
      this.value.nativeItems.splice(0, dropped);
      for (const [key, at] of this.textItems) {
        if (at < dropped) this.textItems.delete(key);
        else this.textItems.set(key, at - dropped);
      }
    }
    return this.value.nativeItems.length - 1;
  }
}
