import { AppError } from 'stitchkit';
import { z } from 'zod';
import { connectOwnedCodex } from '../agent/codex/ownedRpc.ts';
import { inspectNativeCodexInput } from '../agent/codex/pane.ts';
import { codexTextInput } from '../agent/codex/turnInput.ts';
import { resolveMessageAttachments, withPinnedAttachments } from '../attachments/pins.ts';
import { chatPrincipalKey } from '../chat/identity.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { capturePaneStyled, clientTypingRecently, setPaneInputEnabled } from '../tmux/tmux.ts';
import type { ChatPrincipal, MachineConfig, Session } from '../types.ts';
import {
  requireNativeSteeringTurn,
  requireSteeringTurn,
  steeringTarget,
  validateSteeringImages,
} from './preflight.ts';
import { priorSteering, reconcileSteering } from './receipt.ts';
import {
  STEERING_LIMITS,
  type SteeringInput,
  SteeringInputSchema,
  type SteeringOperation,
  type SteeringReceipt,
  SteeringReceiptSchema,
  type SteeringSelector,
  SteeringSelectorSchema,
} from './schema.ts';
import {
  readSteeringJournal,
  steeringFailure,
  steeringFingerprint,
  writeSteeringJournal,
} from './store.ts';

export const steeringDependencies = {
  connect: connectOwnedCodex,
  readStatus: readManagedRuntimeStatus,
  typing: clientTypingRecently,
  gate: setPaneInputEnabled,
  capture: capturePaneStyled,
  images: validateSteeringImages,
};
export type SteeringDependencies = typeof steeringDependencies;

async function safeSteering<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    return steeringFailure('STEERING_UNAVAILABLE', 503);
  }
}

export async function steerNativeTurn(
  m: MachineConfig,
  principal: ChatPrincipal,
  raw: SteeringInput,
  callerSignal: AbortSignal,
  deps: SteeringDependencies = steeringDependencies,
): Promise<SteeringReceipt> {
  const input = SteeringInputSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(input)) > STEERING_LIMITS.requestBytes)
    return steeringFailure('CAPACITY');
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(STEERING_LIMITS.deadlineMs)]);
  const session = steeringTarget(m, input, false);
  return safeSteering(() =>
    withNativeAdmission(m, session, () =>
      withSessionRegistryLock(m, async () => {
        signal.throwIfAborted();
        steeringTarget(m, input, false);
        const journal = readSteeringJournal(m, session),
          fingerprint = steeringFingerprint(principal, input);
        const prior = priorSteering(journal, principal, input.operationId, fingerprint);
        if (prior)
          return reconcileSteering(m, session, journal, prior, () =>
            deps.connect(m, session, { signal }),
          );
        if (journal.operations.length >= STEERING_LIMITS.operations)
          return steeringFailure('CAPACITY');
        requireSteeringTurn(m, session, input, deps.readStatus);
        await deps.images(m, session, input, signal);
        if (await deps.typing(m, session.name, 3)) return steeringFailure('BUSY');
        return submit(m, session, principal, input, signal, deps, journal, fingerprint);
      }),
    ),
  );
}

async function submit(
  m: MachineConfig,
  session: Session,
  principal: ChatPrincipal,
  input: SteeringInput,
  signal: AbortSignal,
  deps: SteeringDependencies,
  journal: ReturnType<typeof readSteeringJournal>,
  fingerprint: string,
) {
  let gated = false;
  const rpc = await deps.connect(m, session, { signal });
  try {
    gated = await deps.gate(m, session.name, false);
    if (
      !gated ||
      inspectNativeCodexInput(await deps.capture(m, session.name, 40)).state !== 'deliverable'
    )
      return steeringFailure('BUSY');
    await requireNativeSteeringTurn(rpc, input);
    await withPinnedAttachments(
      m,
      principal,
      input.target,
      input.operationId,
      input.images,
      async () => undefined,
      signal,
    );
    const attachments = await resolveMessageAttachments(
      m,
      session,
      input.operationId,
      input.images,
      signal,
    );
    const nativeInput = codexTextInput(input.body);
    for (const attachment of attachments)
      nativeInput.push({ type: 'localImage', path: attachment.path });
    requireSteeringTurn(m, session, input, deps.readStatus);
    signal.throwIfAborted();
    const operation: SteeringOperation = {
      fingerprint,
      principal: chatPrincipalKey(principal),
      phase: 'intent',
      reason: null,
      receipt: SteeringReceiptSchema.parse({
        protocol: 1,
        operationId: input.operationId,
        target: input.target,
        registrationGeneration: input.registrationGeneration,
        generation: input.generation,
        turnId: input.expectedTurnId,
        clientUserMessageId: `steer:${input.operationId}`,
        state: 'uncertain',
        observedAt: new Date().toISOString(),
      }),
    };
    journal.operations.push(operation);
    writeSteeringJournal(m, session, journal);
    try {
      const response = z.object({ turnId: z.string() }).parse(
        await rpc.request('turn/steer', {
          threadId: session.uuid,
          expectedTurnId: input.expectedTurnId,
          clientUserMessageId: operation.receipt.clientUserMessageId,
          input: nativeInput,
        }),
      );
      if (response.turnId !== input.expectedTurnId) throw new Error('native-turn-mismatch');
      operation.phase = 'submitted';
    } catch {
      operation.phase = 'uncertain';
      operation.reason = 'native-acceptance-unresolved';
    }
    operation.receipt = {
      ...operation.receipt,
      state: operation.phase,
      observedAt: new Date().toISOString(),
    };
    writeSteeringJournal(m, session, journal);
    return operation.receipt;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return steeringFailure('STEERING_UNAVAILABLE', 503);
  } finally {
    try {
      if (gated) await deps.gate(m, session.name, true);
    } finally {
      rpc.close();
    }
  }
}

export async function readNativeSteering(
  m: MachineConfig,
  principal: ChatPrincipal,
  raw: SteeringSelector,
  callerSignal: AbortSignal,
  deps: SteeringDependencies = steeringDependencies,
): Promise<{ operation: SteeringReceipt | null }> {
  const input = SteeringSelectorSchema.parse(raw),
    session = steeringTarget(m, input, false);
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(STEERING_LIMITS.deadlineMs)]);
  return safeSteering(() =>
    withNativeAdmission(m, session, () =>
      withSessionRegistryLock(m, async () => {
        signal.throwIfAborted();
        steeringTarget(m, input, false);
        const journal = readSteeringJournal(m, session),
          prior = priorSteering(journal, principal, input.operationId);
        return {
          operation:
            prior === null
              ? null
              : await reconcileSteering(m, session, journal, prior, () =>
                  deps.connect(m, session, { signal }),
                ),
        };
      }),
    ),
  );
}
