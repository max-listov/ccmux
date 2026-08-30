import { readRuntimeInput } from '../../runtime/input.ts';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../runtime/interrupt.ts';
import type { MachineConfig, Session } from '../../types.ts';
import {
  clearNativeCommand,
  readNativeCommand,
  readNativeReceipt,
  writeNativeReceipt,
} from '../codex/ownedControl.ts';
import type { CustomChronology } from './chronology.ts';
import type { CustomCorrelation } from './correlation.ts';
import type { openCustomEngine } from './engine.ts';
import { prepareCustomHost } from './host.ts';
import { CustomInputMetadataSchema } from './input.ts';
import type { CustomProjection } from './projection.ts';
export interface CustomControlContext {
  m: MachineConfig;
  session: Session;
  runtime: Awaited<ReturnType<typeof openCustomEngine>>;
  projection: CustomProjection;
  correlation: CustomCorrelation;
  observeResult(result: Promise<unknown>): void;
  changed(): void;
  chronology?: CustomChronology;
}
export async function applyCustomResponse(context: CustomControlContext): Promise<void> {
  const command = readNativeCommand(context.m, context.session.name);
  if (!command) return;
  const receipt = (outcome: 'submitted' | 'rejected' | 'uncertain', reason: string | null) =>
    writeNativeReceipt(context.m, context.session.name, {
      operationId: command.operationId,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      outcome,
      reason,
    });
  const prior = readNativeReceipt(context.m, context.session.name);
  if (prior?.operationId === command.operationId && prior.outcome !== 'uncertain') {
    if (prior.fingerprint !== command.fingerprint)
      throw new Error('Native response identity conflicts');
    clearNativeCommand(context.m, context.session.name);
    return;
  }
  const input = readRuntimeInput(context.m, context.session);
  if (!input) throw new Error('Native approval has no managed admission');
  const reconciled = await context.correlation.reconcile(input);
  const submitted = reconciled.continuations.find(
    (c) => c.responseOperationId === command.operationId,
  );
  if (submitted) {
    if (
      submitted.requestId !== command.requestId ||
      submitted.decision !== command.decision ||
      submitted.responseFingerprint !== command.fingerprint
    )
      throw new Error('Native durable response conflicts with its command');
    await receipt('submitted', null);
    clearNativeCommand(context.m, context.session.name);
    return;
  }
  const request = context.correlation.pending.find((p) => p.approvalId === command.requestId);
  if (
    !request ||
    command.generation !== context.projection.snapshot().generation ||
    command.kind !== 'approval' ||
    (command.decision !== 'accept' && command.decision !== 'decline') ||
    reconciled.continuations.length >= 32 ||
    context.projection.snapshot().turn?.status === 'inProgress'
  ) {
    await receipt('rejected', 'request-identity-or-state-mismatch');
    clearNativeCommand(context.m, context.session.name);
    return;
  }
  prepareCustomHost(context.m, context.session);
  const original = (await context.correlation.messages()).find(
    (message) => message.id === `input:${input.messageId}`,
  );
  const metadata = CustomInputMetadataSchema.parse(original?.metadata);
  await receipt('uncertain', null);
  const ticket = await context.runtime.harness.respondToApproval({
    conversationId: context.runtime.conversationId,
    approvalId: request.approvalId,
    approved: command.decision === 'accept',
    context: context.runtime.context,
    metadata: {
      ...metadata,
      parentRunId: request.runId,
      responseOperationId: command.operationId,
      responseFingerprint: command.fingerprint,
    },
  });
  context.observeResult(ticket.result);
  await ticket.admission;
  await context.correlation.reconcile(input);
  await receipt('submitted', null);
  context.chronology?.record('request-answered', command.requestId);
  clearNativeCommand(context.m, context.session.name);
}
export async function applyCustomInterrupt(context: CustomControlContext): Promise<void> {
  const command = readRuntimeInterrupt(context.m, context.session);
  if (!command || !['queued', 'uncertain'].includes(command.phase)) return;
  if (!isCancellableTurn(context.projection.snapshot(), command.generation, command.turnId)) {
    await writeRuntimeInterrupt(context.m, context.session, { ...command, phase: 'rejected' });
    return;
  }
  await writeRuntimeInterrupt(context.m, context.session, { ...command, phase: 'uncertain' });
  context.chronology?.record('interrupt-requested', command.turnId);
  await context.runtime.harness.interrupt({
    conversationId: context.runtime.conversationId,
    runId: command.turnId,
  });
  await writeRuntimeInterrupt(context.m, context.session, { ...command, phase: 'accepted' });
  context.changed();
}
