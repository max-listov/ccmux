import { AppError } from 'stitchkit';
import { readCodexAppThread } from '../agent/codex/appServer.ts';
import { isOwnedCodex } from '../agent/codex/ownedPaths.ts';
import { connectOwnedCodex } from '../agent/codex/ownedRpc.ts';
import { readOwnedCodexStatus } from '../agent/codex/ownedStatus.ts';
import { managedPeerKey } from '../chat/identity.ts';
import { loadCursors } from '../chat/store.ts';
import { blockingInbound } from '../commands/wait.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import { isCancellableTurn, requestRuntimeInterrupt } from '../runtime/interrupt.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { MachineConfig, ManagedPeer } from '../types.ts';
import type { ControlPublisher } from './publisher.ts';
import { ControlWaitResultSchema } from './schema.ts';
import { controlTarget } from './target.ts';

export async function interruptControlTurn(
  m: MachineConfig,
  target: ManagedPeer,
  generation: string,
  turnId: string,
  signal: AbortSignal,
) {
  return withSessionRegistryLock(m, async () => {
    signal.throwIfAborted();
    const session = controlTarget(m, target);
    if (!hasNativeRuntime(session))
      throw new AppError('UNSUPPORTED', 'Native interruption is unavailable for this runtime', 409);
    if (!isOwnedCodex(session)) {
      await requestRuntimeInterrupt(m, session, generation, turnId, signal);
      return { target, accepted: true } satisfies { target: ManagedPeer; accepted: true };
    }
    const read = readOwnedCodexStatus(m, session);
    if (
      read.status !== 'live' ||
      !read.snapshot ||
      !isCancellableTurn(read.snapshot, generation, turnId)
    ) {
      throw new AppError('TURN_MISMATCH', 'The exact active turn is unavailable', 409);
    }
    const rpc = await connectOwnedCodex(m, session, { signal });
    try {
      const thread = await readCodexAppThread(rpc, session.uuid);
      controlTarget(m, target);
      const current = readOwnedCodexStatus(m, session);
      if (
        thread.status.type !== 'active' ||
        thread.status.activeFlags.some(
          (flag) => !['waitingOnApproval', 'waitingOnUserInput'].includes(flag),
        ) ||
        current.status !== 'live' ||
        !current.snapshot ||
        !isCancellableTurn(current.snapshot, generation, turnId)
      ) {
        throw new AppError('TURN_MISMATCH', 'The exact active turn is unavailable', 409);
      }
      signal.throwIfAborted();
      await rpc.request('turn/interrupt', { threadId: target.threadId, turnId });
      return { target, accepted: true } satisfies { target: ManagedPeer; accepted: true };
    } finally {
      rpc.close();
    }
  });
}

export async function waitControlSession(
  m: MachineConfig,
  publisher: ControlPublisher,
  target: ManagedPeer,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const session = controlTarget(m, target);
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'Resident wait requires a native runtime', 409);
  const timeout = AbortSignal.timeout(timeoutMs);
  const startedAt = Date.now();
  const combined = AbortSignal.any([signal, timeout]);
  let state =
    publisher.read().sessions.find((row) => row.identity.session === target.session) ?? null;
  for await (const snapshot of publisher.subscribe(combined)) {
    signal.throwIfAborted();
    controlTarget(m, target);
    state = snapshot.sessions.find((row) => row.identity.session === target.session) ?? null;
    if (
      state?.identity.threadId !== target.threadId ||
      state.availability !== 'live' ||
      Date.parse(state.observedAt) < startedAt
    )
      continue;
    if (state.turn?.status === 'failed')
      return ControlWaitResultSchema.parse({ target, outcome: 'failed', state });
    if (
      state.state === 'idle' &&
      state.turn?.status !== 'inProgress' &&
      loadCursors(m).pickups[managedPeerKey(target)] === undefined &&
      blockingInbound(m, session, Date.now()).length === 0
    ) {
      return ControlWaitResultSchema.parse({
        target,
        outcome: state.turn?.status ?? 'idle',
        state,
      });
    }
  }
  signal.throwIfAborted();
  return ControlWaitResultSchema.parse({
    target,
    outcome: timeout.aborted ? 'timeout' : 'unavailable',
    state,
  });
}
