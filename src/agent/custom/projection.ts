import {
  type AgentMessage,
  type AgentRuntimeEvent,
  type AgentRuntimeEventCursor,
  advanceAgentRuntimeEventCursor,
} from 'stitchkit/agent-runtime';
import type { AgentHarnessPendingApproval } from 'stitchkit/agent-runtime/harness';
import type { ContentBuffer } from '../../content/buffer.ts';
import type { RuntimeAppliedProfile } from '../../policy/runtimeProfile.ts';
import type { NativePendingRequest } from '../../runtime/projectionSchema.ts';
import type { ManagedRuntimeSnapshot } from '../../runtime/schema.ts';
import type { NativeModelSelection } from '../../runtime/selectionSchema.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { VERSION } from '../../util/version.ts';
import { customMessageContent, customToolEvent } from './content.ts';
import { CustomInputMetadataSchema } from './input.ts';
import { appendCustomMetadata } from './metadata.ts';

export function customTerminal(reason: string): 'completed' | 'interrupted' | 'failed' {
  if (reason === 'success' || reason === 'provider_stop') return 'completed';
  if (['interrupted', 'cancelled', 'shutdown'].includes(reason)) return 'interrupted';
  return 'failed';
}

/** Observation only. Canonical runs and requests stay in the Harness SQLite store. */
export class CustomProjection {
  private value: ManagedRuntimeSnapshot;
  private cursor: AgentRuntimeEventCursor = {};
  constructor(
    m: MachineConfig,
    s: Session,
    private content: ContentBuffer,
    generation: string,
  ) {
    const at = new Date().toISOString();
    this.value = {
      protocol: 1,
      provider: 'custom',
      machine: m.rcPrefix,
      session: s.name,
      threadId: s.uuid,
      generation,
      registrationGeneration: s.registrationGeneration,
      nativeSession: s.nativeSession,
      nativeSelection: null,
      sequence: 0,
      pid: process.pid,
      providerPid: process.pid,
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
    return structuredClone(this.value);
  }
  selection(model: NativeModelSelection, turnId: string): void {
    this.value.nativeSelection = {
      model,
      options: { runtime: 'custom', model },
      source: 'admission',
      turnId,
    };
  }
  profile(value: RuntimeAppliedProfile): void {
    this.value.nativeProfile = value;
  }
  touch(kind: ManagedRuntimeSnapshot['events'][number]['kind'] = 'state'): void {
    const now = Date.now();
    this.value.observedAt = new Date(now).toISOString();
    this.value.expiresAt = new Date(now + 5000).toISOString();
    this.value.events.push({
      sequence: ++this.value.sequence,
      at: this.value.observedAt,
      kind,
      state: this.value.state,
      turn: this.value.turn === null ? null : { ...this.value.turn },
    });
    if (this.value.events.length > 128) this.value.events.shift();
  }
  unavailable(reason: string): void {
    this.value.connected = false;
    this.value.state = 'unknown';
    this.value.reason = reason;
    this.touch('unavailable');
  }
  ready(): void {
    this.value.connected = true;
    this.value.reason = null;
    this.value.state =
      this.value.pendingRequests.length > 0
        ? 'waiting-approval'
        : this.value.turn?.status === 'inProgress'
          ? 'working'
          : 'idle';
    this.touch();
  }
  run(id: string, status: NonNullable<ManagedRuntimeSnapshot['turn']>['status'], at: string): void {
    this.value.turn = { id, status, startedAt: at };
    if (status !== 'inProgress') this.content.lifecycle('terminal', id, id, status);
    this.ready();
  }
  requests(pending: readonly AgentHarnessPendingApproval[]): void {
    if (pending.length > 16) throw new Error('Native approval window exceeded');
    const previous = this.value.pendingRequests;
    this.value.pendingRequests = pending.map(
      (request): NativePendingRequest => ({
        requestId: request.approvalId,
        rpcId: request.approvalId,
        kind: 'approval',
        approvalKind: null,
        turnId: request.runId,
        itemId: request.callId,
        reason: `Permission required: ${request.toolName.slice(0, 128)}`,
        scope: null,
        decisions: ['accept', 'decline'],
        questions: [],
        requestedAt: this.value.observedAt,
      }),
    );
    for (const request of previous)
      if (!pending.some((p) => p.approvalId === request.requestId))
        this.content.lifecycle('request', request.turnId, request.requestId, 'resolved');
    for (const request of this.value.pendingRequests)
      this.content.lifecycle(
        'request',
        request.turnId,
        request.requestId,
        'requested',
        request.reason,
      );
    this.ready();
  }
  message(message: AgentMessage): void {
    if (message.conversationId !== this.value.nativeSession?.id || !message.runId) return;
    customMessageContent(this.content, message);
  }
  /** A gap never becomes idle. The owner must refresh canonical evidence before admitting work. */
  event(event: AgentRuntimeEvent): void {
    if (event.conversationId !== this.value.nativeSession?.id)
      throw new Error('Native event identity differs');
    const advanced = advanceAgentRuntimeEventCursor(this.cursor, event);
    if (advanced.status === 'duplicate') return;
    const epochChanged =
      'runtimeEpoch' in event &&
      this.cursor.runtimeEpoch !== undefined &&
      this.cursor.runtimeEpoch !== event.runtimeEpoch;
    this.cursor = advanced.cursor;
    if ((this.cursor.durableEventIds?.length ?? 0) > 8)
      throw new Error('Native durable event window exceeded');
    if (advanced.status === 'gap' || epochChanged) {
      this.content.resetContext();
      this.unavailable('native-resync-required');
      return;
    }
    appendCustomMetadata(this.value, event);
    if (event.type === 'admission') {
      const metadata = CustomInputMetadataSchema.parse(event.input.metadata);
      this.value.nativeSelection = {
        model: metadata.model,
        options: { runtime: 'custom', model: metadata.model },
        source: 'admission',
        turnId: event.runId,
      };
      this.run(event.runId, 'inProgress', event.emittedAt);
    } else if (event.type === 'assistant-delta' || event.type === 'reasoning-delta') {
      const kind = event.type === 'assistant-delta' ? 'assistant' : 'reasoning-summary';
      this.content.text(
        kind,
        event.runId,
        `${event.runId}:${kind === 'assistant' ? 'assistant' : 'reasoning'}`,
        event.textDelta,
        'append',
      );
    } else if (event.type === 'assistant-checkpoint' || event.type === 'terminal') {
      this.message(event.message);
      if (event.type === 'terminal') {
        const status = customTerminal(event.reason);
        this.value.turn = {
          id: event.runId,
          status,
          startedAt: this.value.turn?.startedAt ?? event.emittedAt,
        };
        // Request extraction and correlation happen from the canonical store before ready().
        this.value.state = 'unknown';
        this.value.reason = 'awaiting-canonical-terminal';
        this.content.lifecycle('terminal', event.runId, event.runId, status);
        this.touch('turn-end');
      }
    } else if (event.type === 'tool-status') {
      customToolEvent(this.content, event);
    }
    this.touch();
  }
}
