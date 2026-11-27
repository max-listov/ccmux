import type { z } from 'zod';
import type { ManagedPeerSchema } from '../chat/identitySchema.ts';
import { readMessageJournal } from '../chat/messageOperationStore.ts';
import { readContent, subscribeContent } from '../content/read.ts';
import type { ContentRead } from '../content/schema.ts';
import { sessionApplicationPolicy } from '../policy/projection.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import {
  nativeResponseFingerprint,
  readNativeCommand,
  readNativeReceipt,
  writeNativeCommand,
} from '../runtime/response.ts';
import { readSelection } from '../runtime/selection.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig } from '../types.ts';
import type { ControlNativeSnapshot } from './schema/native.ts';
import { refusals } from './schema/refusals.ts';
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
    throw refusals.errors.UNSUPPORTED({
      message: 'Native feed requires an owned structured runtime',
    });
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
    throw refusals.errors.UNAVAILABLE({
      message: `Native projection is ${read.reason ?? read.status}`,
    });
  const snapshot = read.snapshot;
  if (content.generation !== snapshot.generation)
    throw refusals.errors.UNAVAILABLE({ message: 'Native generation changed' });
  return {
    ...content,
    observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt,
    pending: snapshot.pendingRequests.map(({ rpcId: _rpcId, ...pending }) => pending),
    // The daemon carries every request the runtime is blocked on. Shedding happens at the remote transport,
    // where a budget exists; here there is nothing to omit and nothing to claim was omitted.
    omittedPending: 0,
    ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }),
    selection: readSelection(m, session),
    nativeSelection: snapshot.nativeSelection ?? null,
    ...(snapshot.nativeProfile === undefined ? {} : { nativeProfile: snapshot.nativeProfile }),
    driverCapabilities: runtimeCapabilities(session),
    ...sessionApplicationPolicy(m, session, session.applicationPolicy, read),
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
    throw refusals.errors.UNSUPPORTED({
      message: 'Native feed requires an owned structured runtime',
    });
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
  if (session.delegation?.applicationAuthority !== undefined)
    throw refusals.errors.DELEGATION_REFUSED({
      message: 'Application child input requires its attested message route',
    });
  if (!hasNativeRuntime(session))
    throw refusals.errors.UNSUPPORTED({
      message: 'Native responses require an owned structured runtime',
    });
  const fingerprint = nativeResponseFingerprint(input);
  const canonical = readMessageJournal(m, session)
    ?.records.flatMap((record) => record.continuations)
    .find((continuation) => continuation.responseOperationId === input.operationId);
  if (canonical) {
    if (canonical.responseFingerprint !== fingerprint || canonical.requestId !== input.requestId)
      throw refusals.errors.IDEMPOTENCY_CONFLICT({ message: 'Native response payload changed' });
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
      throw refusals.errors.IDEMPOTENCY_CONFLICT({ message: 'Native response payload changed' });
    if (prior.outcome !== 'rejected')
      return { operationId: input.operationId, requestId: input.requestId, outcome: prior.outcome };
    throw refusals.errors.STALE_REQUEST({
      message: prior.reason ?? 'Native response was rejected',
    });
  }
  const snapshot = readControlNative(m, input.target, null);
  if (snapshot.generation !== input.generation)
    throw refusals.errors.STALE_REQUEST({ message: 'Projection generation changed' });
  const pending = snapshot.pending.find((item) => item.requestId === input.requestId);
  if (!pending || pending.kind !== input.kind)
    throw refusals.errors.STALE_REQUEST({ message: 'Native request is not pending' });
  const active = readNativeCommand(m, input.target.session);
  if (active !== null && active.operationId !== input.operationId)
    throw refusals.errors.BUSY({ message: 'Another native response is pending' });
  if (active !== null && active.fingerprint !== fingerprint)
    throw refusals.errors.IDEMPOTENCY_CONFLICT({ message: 'Native response payload changed' });
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
      throw refusals.errors.STALE_REQUEST({
        message: receipt.reason ?? 'Native response was rejected',
      });
    }
    await Bun.sleep(25);
  }
  return {
    operationId: input.operationId,
    requestId: input.requestId,
    outcome: 'uncertain' as const,
  };
}
