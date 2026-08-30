import type { AgentMessage } from 'stitchkit/agent-runtime';
import type { AgentHarnessPendingApproval } from 'stitchkit/agent-runtime/harness';
import type { NativeContinuation } from '../../chat/messageOperationSchema.ts';
import {
  advanceMessageOperation,
  projectMessageContinuation,
} from '../../chat/messageOperationStore.ts';
import { type RuntimeInput, writeRuntimeInput } from '../../runtime/input.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { stableJson } from '../launchInputs.ts';
import type { openCustomEngine } from './engine.ts';
import { CustomInputMetadataSchema, customInputParts } from './input.ts';
import { type CustomProjection, customTerminal } from './projection.ts';

type Engine = Awaited<ReturnType<typeof openCustomEngine>>;
export class CustomCorrelation {
  pending: readonly AgentHarnessPendingApproval[] = [];
  constructor(
    private m: MachineConfig,
    private session: Session,
    private runtime: Engine,
    private projection: CustomProjection,
  ) {}
  private get conversationId(): string {
    return this.runtime.conversationId;
  }
  async messages(): Promise<readonly AgentMessage[]> {
    // One user admission plus at most 32 approval successors: at most 66 records.
    // This bounded canonical window is read at a transition, never each observation tick.
    const page = await this.runtime.sqlite.conversations.messages({
      conversationId: this.conversationId,
      limit: 128,
      direction: 'before',
    });
    return page.items;
  }
  async reconcile(input: RuntimeInput): Promise<RuntimeInput> {
    const messages = await this.messages();
    const original = messages.find((message) => message.id === `input:${input.messageId}`);
    const initial = await this.runtime.sqlite.store.loadRun({
      conversationId: this.conversationId,
      runId: input.nativeId,
    });
    if (!initial) {
      if (input.phase === 'accepted') throw new Error('Accepted native admission disappeared');
      return input;
    }
    if (original?.role !== 'user' || !initial.run.inputMessageIds.includes(original.id))
      throw new Error('Native admission is outside its bounded canonical window');
    const metadata = CustomInputMetadataSchema.parse(original.metadata);
    if (
      metadata.messageId !== input.messageId ||
      metadata.registration !== this.session.registrationGeneration ||
      metadata.recipeDigest !== this.session.launchRecipe?.digest ||
      input.turnOptions?.options.runtime !== 'custom' ||
      stableJson(metadata.model) !== stableJson(input.turnOptions.options.model) ||
      stableJson(metadata.images) !== stableJson(input.images ?? []) ||
      stableJson(original.parts) !== stableJson(customInputParts(input))
    )
      throw new Error('Native admission does not match its managed mailbox');
    const active = await this.runtime.sqlite.store.listActiveRuns(this.conversationId);
    if (active.length > 32) throw new Error('Native active-run window exceeded');
    const runs = new Map(active.map((run) => [run.id, run]));
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.runId || runs.has(message.runId)) continue;
      const found = await this.runtime.sqlite.store.loadRun({
        conversationId: this.conversationId,
        runId: message.runId,
      });
      if (found) runs.set(found.run.id, found.run);
    }
    const continuations = messages
      .filter(
        (message) => message.role === 'tool' && message.metadata?.messageId === input.messageId,
      )
      .map((message): NativeContinuation => {
        const data = CustomInputMetadataSchema.parse(message.metadata);
        const nativeRuns = [...runs.values()].filter((run) =>
          run.inputMessageIds.includes(message.id),
        );
        const runId = nativeRuns.length === 1 ? nativeRuns[0]?.id : undefined;
        const part = message.parts.find((part) => part.type === 'tool-approval-response');
        if (
          !part ||
          !runId ||
          !data.parentRunId ||
          !data.responseOperationId ||
          !data.responseFingerprint ||
          data.registration !== metadata.registration ||
          data.recipeDigest !== metadata.recipeDigest ||
          stableJson(data.model) !== stableJson(metadata.model)
        )
          throw new Error('Native approval continuation identity differs');
        return {
          requestId: part.approvalId,
          parentTurnId: data.parentRunId,
          responseOperationId: data.responseOperationId,
          responseFingerprint: data.responseFingerprint,
          turnId: runId,
          decision: part.approved ? 'accept' : 'decline',
        };
      });
    const knownRuns = new Set([input.nativeId]);
    for (const continuation of continuations) {
      if (!knownRuns.has(continuation.parentTurnId) || knownRuns.has(continuation.turnId))
        throw new Error('Native continuation ancestry is invalid');
      knownRuns.add(continuation.turnId);
    }
    const answered = new Set(continuations.map((c) => c.requestId));
    const pending: AgentHarnessPendingApproval[] = [];
    for (const message of messages) {
      if (!message.runId || !knownRuns.has(message.runId)) continue;
      for (const part of message.parts)
        if (part.type === 'tool-approval-request' && !answered.has(part.approvalId)) {
          const call = message.parts.find(
            (item) => item.type === 'tool-call' && item.callId === part.callId,
          );
          if (call?.type !== 'tool-call' || !part.signature)
            throw new Error('Canonical signed approval is incomplete');
          pending.push({
            conversationId: this.conversationId,
            runId: message.runId,
            messageId: message.id,
            approvalId: part.approvalId,
            callId: part.callId,
            toolName: call.toolName,
            input: call.input,
            signature: part.signature,
          });
        }
    }
    const latestId = continuations.at(-1)?.turnId ?? input.nativeId;
    const latest =
      latestId === input.nativeId
        ? initial
        : await this.runtime.sqlite.store.loadRun({
            conversationId: this.conversationId,
            runId: latestId,
          });
    if (!latest) throw new Error('Native successor is absent');
    const terminal =
      latest.run.terminalReason === undefined
        ? undefined
        : customTerminal(latest.run.terminalReason);
    this.pending = pending;
    this.projection.selection(metadata.model, latestId);
    if (latest.assistant && 'parts' in latest.assistant) this.projection.message(latest.assistant);
    this.projection.run(latestId, terminal ?? 'inProgress', latest.run.createdAt);
    this.projection.requests(pending);
    const result: RuntimeInput = {
      ...input,
      phase: 'accepted',
      continuations,
      ...(terminal !== undefined && pending.length === 0 ? { terminal } : {}),
    };
    if (pending.length > 0) delete result.terminal;
    await writeRuntimeInput(this.m, this.session, result);
    advanceMessageOperation(this.m, this.session, input.messageId, 'admitted', input.nativeId);
    projectMessageContinuation(this.m, this.session, input.messageId, {
      continuations,
      pendingApprovals: pending.map((p) => ({
        requestId: p.approvalId,
        turnId: p.runId,
        callId: p.callId,
      })),
    });
    if (result.terminal)
      advanceMessageOperation(
        this.m,
        this.session,
        input.messageId,
        result.terminal,
        input.nativeId,
      );
    return result;
  }
}
