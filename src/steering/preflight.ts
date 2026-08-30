import { z } from 'zod';
import { ThreadStatusSchema } from '../agent/codex/appServer.ts';
import type { CodexAppRpc } from '../agent/codex/rpc.ts';
import { managedPeer, managedPeerKey } from '../chat/identity.ts';
import { loadCursors, loadLedger } from '../chat/store.ts';
import { assertNoContextMutation } from '../context/store.ts';
import { validateTurnOptions } from '../control/selection.ts';
import { controlTarget } from '../control/target.ts';
import type { ManagedRuntimeRead } from '../runtime/schema.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import type { SteeringInput, SteeringSelector } from './schema.ts';
import { steeringFailure } from './store.ts';

export function steeringTarget(m: MachineConfig, input: SteeringSelector, mutate = true): Session {
  const session = controlTarget(m, input.target);
  if (session.registrationGeneration !== input.registrationGeneration)
    return steeringFailure('IDENTITY_MISMATCH');
  if (session.agent !== 'codex' || session.runtime !== 'app-server')
    return steeringFailure('UNSUPPORTED');
  if (mutate && session.archived) return steeringFailure('UNAVAILABLE');
  return session;
}

export function requireSteeringTurn(
  m: MachineConfig,
  s: Session,
  input: SteeringInput,
  read: (m: MachineConfig, s: Session) => ManagedRuntimeRead = readManagedRuntimeStatus,
): void {
  steeringTarget(m, input);
  assertNoContextMutation(m, s);
  const state = read(m, s);
  if (state.status !== 'live' || state.snapshot === null || !state.snapshot.connected)
    steeringFailure('UNAVAILABLE');
  if (
    state.snapshot.generation !== input.generation ||
    state.snapshot.turn?.id !== input.expectedTurnId
  )
    steeringFailure('IDENTITY_MISMATCH');
  if (
    state.snapshot.state !== 'working' ||
    state.snapshot.turn.status !== 'inProgress' ||
    state.snapshot.pendingRequests.length > 0
  )
    steeringFailure('BUSY');
}

/** A direct read narrows the projection race; expectedTurnId remains the actual atomic precondition. */
export async function requireNativeSteeringTurn(
  rpc: CodexAppRpc,
  input: SteeringInput,
): Promise<void> {
  const response = z
    .object({ thread: z.object({ id: z.string(), status: ThreadStatusSchema }) })
    .parse(
      await rpc.request('thread/read', {
        threadId: input.target.threadId,
        includeTurns: false,
      }),
    );
  if (response.thread.id !== input.target.threadId) return steeringFailure('IDENTITY_MISMATCH');
  if (response.thread.status.type !== 'active' || response.thread.status.activeFlags.length !== 0)
    return steeringFailure('BUSY');
}

/** Future defaults cannot establish the active turn's modality, including an interactive override. */
export async function validateSteeringImages(
  m: MachineConfig,
  s: Session,
  input: SteeringInput,
  signal: AbortSignal,
): Promise<void> {
  if (input.images.length === 0) return;
  const pickup = loadCursors(m).pickups[managedPeerKey(managedPeer(m.rcPrefix, s))];
  if (pickup?.native?.phase !== 'accepted' || pickup.native.turnId !== input.expectedTurnId)
    return steeringFailure('UNSUPPORTED');
  const message = loadLedger(m).find((row) => row?.id === pickup.messageId);
  if (
    message?.turnOptions === undefined ||
    message.to.kind !== 'managed' ||
    managedPeerKey(message.to) !== managedPeerKey(input.target)
  )
    return steeringFailure('UNSUPPORTED');
  await validateTurnOptions(m, s, message.turnOptions.options, signal, true);
}
