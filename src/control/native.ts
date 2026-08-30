import { AppError } from 'stitchkit';
import { readCodexAppThread } from '../agent/codex/appServer.ts';
import { connectOwnedCodex } from '../agent/codex/ownedRpc.ts';
import { readOwnedCodexStatus } from '../agent/codex/ownedStatus.ts';
import { managedPeerKey } from '../chat/identity.ts';
import { loadCursors } from '../chat/store.ts';
import { blockingInbound } from '../commands/wait.ts';
import { withSessionRegistryLock } from '../config/registryLock.ts';
import { hasNativeRuntime } from '../runtime/capabilities.ts';
import { requestRuntimeInterrupt } from '../runtime/interrupt.ts';
import type { MachineConfig, ManagedPeer } from '../types.ts';
import type { ControlPublisher } from './publisher.ts';
import { ControlWaitResultSchema } from './schema.ts';
import { controlTarget } from './target.ts';

export async function interruptControlTurn(
  m: MachineConfig,
  target: ManagedPeer,
  turnId: string,
  signal: AbortSignal,
) {
  return withSessionRegistryLock(m, async () => {
    signal.throwIfAborted();
    const session = controlTarget(m, target);
    if (!hasNativeRuntime(session))
      throw new AppError('UNSUPPORTED', 'Native interruption is unavailable for this runtime', 409);
    if (session.runtime === 'native') {
      await requestRuntimeInterrupt(m, session, turnId, signal);
      return { target, accepted: true } satisfies { target: ManagedPeer; accepted: true };
    }
    const read = readOwnedCodexStatus(m, session);
    if (
      read.status !== 'live' ||
      read.snapshot?.state !== 'working' ||
      read.snapshot.turn?.id !== turnId ||
      read.snapshot.turn.status !== 'inProgress'
    ) {
      throw new AppError('TURN_MISMATCH', 'The exact working turn is unavailable', 409);
    }
    const rpc = await connectOwnedCodex(m, session, { signal });
    try {
      const thread = await readCodexAppThread(rpc, session.uuid);
      controlTarget(m, target);
      if (thread.status.type !== 'active' || thread.status.activeFlags.length !== 0) {
        throw new AppError('TURN_MISMATCH', 'The runtime is not actively computing', 409);
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
