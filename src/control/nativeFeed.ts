import { AppError } from 'stitchkit';
import type { z } from 'zod';
import {
  nativeResponseFingerprint,
  readNativeCommand,
  readNativeReceipt,
  writeNativeCommand,
} from '../agent/codex/ownedControl.ts';
import { readMessageJournal } from '../chat/messageOperationStore.ts';
import type { ManagedPeerSchema } from '../config/schema.ts';
import { readContent, subscribeContent } from '../content/read.ts';
import type { ContentRead } from '../content/schema.ts';
import { projectApplicationPolicy } from '../policy/projection.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { readSelection } from '../runtime/selection.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig } from '../types.ts';
import type { ControlNativeSnapshot } from './schema.ts';
import { controlTarget } from './target.ts';

type Target = z.infer<typeof ManagedPeerSchema>;
type Cursor = { generation: string; sequence: number } | null;

export function readControlNative(
  m: MachineConfig,
  target: Target,
  cursor: Cursor,
): ControlNativeSnapshot {
  const session = controlTarget(m, target);
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'Native feed requires an owned structured runtime', 409);
  return nativeFrame(m, target, readContent(m, session, cursor));
}

function nativeFrame(
  m: MachineConfig,
  target: Target,
  content: ContentRead,
): ControlNativeSnapshot {
  const session = controlTarget(m, target);
  const read = readManagedRuntimeStatus(m, session);
  if (read.status !== 'live' || read.snapshot === null)
    throw new AppError('UNAVAILABLE', `Native projection is ${read.reason ?? read.status}`, 503);
  const snapshot = read.snapshot;
  if (content.generation !== snapshot.generation)
    throw new AppError('UNAVAILABLE', 'Native generation changed', 503);
  return {
    ...content,
    observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt,
    pending: snapshot.pendingRequests.map(({ rpcId: _rpcId, ...pending }) => pending),
    // The daemon carries every request the runtime is blocked on. Shedding happens at the wire,
    // where a budget exists; here there is nothing to omit and nothing to claim was omitted.
    omittedPending: 0,
    ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }),
    selection: readSelection(m, session),
    nativeSelection: snapshot.nativeSelection ?? null,
    ...(snapshot.nativeProfile === undefined ? {} : { nativeProfile: snapshot.nativeProfile }),
    driverCapabilities: runtimeCapabilities(session),
    ...(session.applicationPolicy === undefined
      ? {}
      : {
          applicationPolicy: projectApplicationPolicy(
            session.applicationPolicy,
            read.status,
            snapshot.applicationPolicy,
            read.reason,
          ),
        }),
    ...(snapshot.nativeSession === undefined ? {} : { nativeSession: snapshot.nativeSession }),
  };
}

export async function* subscribeControlNative(
  m: MachineConfig,
  target: Target,
  cursor: Cursor,
  signal: AbortSignal,
): AsyncIterable<ControlNativeSnapshot> {
  const session = controlTarget(m, target);
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'Native feed requires an owned structured runtime', 409);
  let last = '';
  for await (const content of subscribeContent(m, session, cursor, signal)) {
    const frame = nativeFrame(m, target, content);
    const stamp = JSON.stringify([
      frame.generation,
      frame.sequence,
      frame.status,
      frame.observedAt,
      frame.expiresAt,
      frame.pending,
      frame.selection,
      frame.nativeSelection,
      frame.applicationPolicy,
    ]);
    if (stamp === last) continue;
    last = stamp;
    yield frame;
  }
}

export async function respondControlNative(
  m: MachineConfig,
  input: {
    target: Target;
    operationId: string;
    generation: string;
    requestId: string;
    kind: 'approval' | 'input';
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' | null;
    answers: Record<string, string[]> | null;
  },
  signal: AbortSignal,
) {
  const session = controlTarget(m, input.target);
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'Native responses require an owned structured runtime', 409);
  const fingerprint = nativeResponseFingerprint(input);
  const canonical = readMessageJournal(m, session)
    ?.records.flatMap((record) => record.continuations)
    .find((continuation) => continuation.responseOperationId === input.operationId);
  if (canonical) {
    if (canonical.responseFingerprint !== fingerprint || canonical.requestId !== input.requestId)
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Native response payload changed', 409);
    return {
      operationId: input.operationId,
      requestId: input.requestId,
      outcome: 'submitted',
    } satisfies {
      operationId: string;
      requestId: string;
      outcome: 'submitted';
    };
  }
  const prior = readNativeReceipt(m, input.target.session);
  if (prior?.operationId === input.operationId) {
    if (prior.fingerprint !== fingerprint)
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Native response payload changed', 409);
    if (prior.outcome !== 'rejected')
      return { operationId: input.operationId, requestId: input.requestId, outcome: prior.outcome };
    throw new AppError('STALE_REQUEST', prior.reason ?? 'Native response was rejected', 409);
  }
  const snapshot = readControlNative(m, input.target, null);
  if (snapshot.generation !== input.generation)
    throw new AppError('STALE_REQUEST', 'Projection generation changed', 409);
  const pending = snapshot.pending.find((item) => item.requestId === input.requestId);
  if (!pending || pending.kind !== input.kind)
    throw new AppError('STALE_REQUEST', 'Native request is not pending', 409);
  const active = readNativeCommand(m, input.target.session);
  if (active !== null && active.operationId !== input.operationId)
    throw new AppError('BUSY', 'Another native response is pending', 429);
  if (active !== null && active.fingerprint !== fingerprint)
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Native response payload changed', 409);
  if (active === null)
    await writeNativeCommand(m, input.target.session, {
      operationId: input.operationId,
      generation: input.generation,
      requestId: input.requestId,
      fingerprint,
      kind: input.kind,
      decision: input.decision,
      answers: input.answers,
    });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const receipt = readNativeReceipt(m, input.target.session);
    if (receipt?.operationId === input.operationId) {
      if (receipt.outcome !== 'rejected')
        return {
          operationId: input.operationId,
          requestId: input.requestId,
          outcome: receipt.outcome,
        };
      throw new AppError('STALE_REQUEST', receipt.reason ?? 'Native response was rejected', 409);
    }
    await Bun.sleep(25);
  }
  return {
    operationId: input.operationId,
    requestId: input.requestId,
    outcome: 'uncertain' as const,
  };
}
