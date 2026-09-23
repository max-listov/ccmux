/**
 * The mailbox a control call uses to answer a runtime's approval or input request, for every native
 * runtime — Claude, Codex, OpenCode and Custom alike.
 *
 * It lived in the Codex adapter, where it started, while every other runtime and the control plane
 * imported it from there. The files it writes are unchanged — the same `codex-control/<hash>` root,
 * named for its origin — because a runtime owner outlives an update of ccmux: an owner started by the
 * previous version reads these exact paths until its session restarts.
 */
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import type { NativePendingRequest } from './projectionSchema.ts';
import { privateRuntimeDirectory, readPrivateJson } from './store.ts';

export const NativeResponseCommandSchema = z
  .object({
    operationId: z.uuid(),
    generation: z.uuid(),
    requestId: z.string().min(1).max(256),
    fingerprint: z.string().length(64),
    kind: z.enum(['approval', 'input']),
    decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).nullable(),
    answers: z
      .record(z.string().min(1).max(256), z.array(z.string().max(4_096)).min(1).max(32))
      .nullable(),
  })
  .strict();
export type NativeResponseCommand = z.infer<typeof NativeResponseCommandSchema>;
export const NativeResponseReceiptSchema = z
  .object({
    operationId: z.uuid(),
    requestId: z.string().min(1).max(256),
    fingerprint: z.string().length(64),
    outcome: z.enum(['submitted', 'rejected', 'uncertain']),
    reason: z.string().max(512).nullable(),
  })
  .strict();
export type NativeResponseReceipt = z.infer<typeof NativeResponseReceiptSchema>;

export function nativeResponseFingerprint(
  input: Pick<NativeResponseCommand, 'generation' | 'requestId' | 'kind' | 'decision' | 'answers'>,
): string {
  const answers =
    input.answers === null
      ? null
      : Object.fromEntries(
          Object.entries(input.answers)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, values]) => [id, [...values]]),
        );
  return createHash('sha256')
    .update(
      JSON.stringify([input.generation, input.requestId, input.kind, input.decision, answers]),
    )
    .digest('hex');
}

const key = (name: string): string => createHash('sha256').update(name).digest('hex').slice(0, 24);
const root = (m: Pick<MachineConfig, 'stateDir'>, name: string): string =>
  join(m.stateDir, 'codex-control', key(name));
export const nativeCommandPath = (m: Pick<MachineConfig, 'stateDir'>, name: string): string =>
  join(root(m, name), 'command.json');
export const nativeReceiptPath = (m: Pick<MachineConfig, 'stateDir'>, name: string): string =>
  join(root(m, name), 'receipt.json');

export function readNativeCommand(
  m: Pick<MachineConfig, 'stateDir'>,
  name: string,
): NativeResponseCommand | null {
  return readPrivateJson(nativeCommandPath(m, name), NativeResponseCommandSchema, 64 * 1024);
}
export function readNativeReceipt(
  m: Pick<MachineConfig, 'stateDir'>,
  name: string,
): NativeResponseReceipt | null {
  return readPrivateJson(nativeReceiptPath(m, name), NativeResponseReceiptSchema, 64 * 1024);
}
export async function writeNativeCommand(
  m: Pick<MachineConfig, 'stateDir'>,
  name: string,
  command: NativeResponseCommand,
): Promise<void> {
  privateRuntimeDirectory(dirname(nativeCommandPath(m, name)));
  await atomicWrite(
    nativeCommandPath(m, name),
    JSON.stringify(NativeResponseCommandSchema.parse(command)),
    0o600,
  );
}
export async function writeNativeReceipt(
  m: Pick<MachineConfig, 'stateDir'>,
  name: string,
  receipt: NativeResponseReceipt,
): Promise<void> {
  privateRuntimeDirectory(dirname(nativeReceiptPath(m, name)));
  await atomicWrite(
    nativeReceiptPath(m, name),
    JSON.stringify(NativeResponseReceiptSchema.parse(receipt)),
    0o600,
  );
}
export function clearNativeCommand(m: Pick<MachineConfig, 'stateDir'>, name: string): void {
  try {
    unlinkSync(nativeCommandPath(m, name));
  } catch {
    /* already consumed */
  }
}

/**
 * Why a response cannot answer the request it names, or `null` when it can.
 *
 * One reading for every runtime that publishes its requests as `NativePendingRequest`: three copies
 * of this had drifted apart, so the same answer to the same question was refused by one runtime and
 * sent on by another, under three different names for the refusal.
 */
export function nativeResponseRefusal(
  command: NativeResponseCommand,
  request: NativePendingRequest | null,
  generation: string | undefined,
): string | null {
  if (command.generation !== generation) return 'projection-generation-mismatch';
  if (request === null) return 'request-is-not-pending';
  if (request.kind !== command.kind) return 'request-kind-mismatch';
  if (command.kind === 'approval')
    return command.decision !== null && request.decisions.includes(command.decision)
      ? null
      : 'decision-is-not-available';
  if (command.answers === null) return 'answers-are-required';
  const expected = request.questions.map((question) => question.id).sort();
  if (JSON.stringify(Object.keys(command.answers).sort()) !== JSON.stringify(expected))
    return 'question-id-mismatch';
  for (const question of request.questions) {
    const answers = command.answers[question.id] ?? [];
    // Only what the runtime declared: a question that did not say whether it takes several answers
    // is not held to one, and a question without options, or one that accepts its own, takes any.
    if (question.multiple === false && answers.length !== 1) return 'answer-is-not-available';
    if (
      !question.isOther &&
      question.options !== null &&
      answers.some((answer) => !question.options?.some((option) => option.label === answer))
    )
      return 'answer-is-not-available';
  }
  return null;
}

/**
 * Apply the response waiting in a session's mailbox, at most once.
 *
 * The receipt is `uncertain` BEFORE the runtime is told and `submitted` after: a response has side
 * effects, and a process that dies between the two must read back as "may have been applied", never
 * as unanswered — which would send it a second time — nor as rejected, which would be false.
 */
export async function answerNativeCommand(
  m: Pick<MachineConfig, 'stateDir'>,
  name: string,
  runtime: {
    generation: string | undefined;
    pending: (requestId: string) => NativePendingRequest | null;
    submit: (command: NativeResponseCommand, request: NativePendingRequest) => Promise<void>;
  },
): Promise<void> {
  const command = readNativeCommand(m, name);
  if (command === null) return;
  if (readNativeReceipt(m, name)?.operationId === command.operationId) {
    clearNativeCommand(m, name);
    return;
  }
  const receipt = (outcome: NativeResponseReceipt['outcome'], reason: string | null) =>
    writeNativeReceipt(m, name, {
      operationId: command.operationId,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      outcome,
      reason,
    });
  const request = runtime.pending(command.requestId);
  const refusal = nativeResponseRefusal(command, request, runtime.generation);
  if (refusal !== null || request === null) {
    // Refused rather than guessed: a response that does not match a request this runtime holds
    // would otherwise resume some other turn, or none.
    await receipt('rejected', refusal);
    clearNativeCommand(m, name);
    return;
  }
  await receipt('uncertain', null);
  await runtime.submit(command, request);
  await receipt('submitted', null);
  clearNativeCommand(m, name);
}
