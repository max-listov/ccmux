import { randomUUID } from 'node:crypto';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { forkedUuid, providerFor } from '../../agent/index.ts';
import { managedPeer } from '../../chat/identity.ts';
import { controlTarget } from '../../control/target.ts';
import type { ProcessSnapshot } from '../../external/processes.ts';
import { withNativeAdmission } from '../../runtime/admission.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { readManagedRuntimeStatus } from '../../runtime/status.ts';
import { listAgentLiveness } from '../../tmux/agentPane.ts';
import { capturePaneStyled } from '../../tmux/tmux.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { stripAnsi } from '../../util/ansi.ts';
import { readLifecycleBlockForSession } from '../lifecycleBlocks.ts';
import {
  ensureRegistrationGeneration,
  findSession,
  loadSessions,
  updateSessionUuid,
} from '../registry.ts';
import {
  evaluateSleepPolicy,
  isHealthyAwakeState,
  type SessionHealthState,
  sessionProfileKey,
  withProfilePolicyLock,
} from './profilePolicy.ts';
import { idleProof } from './proof.ts';
import { reconcileSleepRecord } from './reconcile.ts';
import { awaitRelease, releaseTuiProcesses } from './release.ts';
import { SleepReceiptSchema, type SleepRecord, type SleepRequestSchema } from './schema.ts';
import { readSleep, sleepBlocksStart, writeSleep } from './store.ts';

export { reconcileSleepRecord } from './reconcile.ts';
export { processesReleased, processesReleasedAsync } from './release.ts';
export { wakeSession, wakeSessionByName, wakeSleepingSession } from './wake.ts';

function refuse(code: string, message: string): never {
  throw new AppError(code, { message, status: 409 });
}

export function assertSleepTarget(
  m: MachineConfig,
  input: { target: Parameters<typeof controlTarget>[1]; registrationGeneration: string },
): Session {
  const s = controlTarget(m, input.target);
  if (s.archived || s.registrationGeneration !== input.registrationGeneration) {
    refuse('IDENTITY_MISMATCH', 'Exact active registration required');
  }
  return s;
}

function receipt(s: Session, row: SleepRecord, state: 'sleeping' | 'awake', duplicate: boolean) {
  return SleepReceiptSchema.parse({
    target: row.target,
    registrationGeneration: row.registrationGeneration,
    operationId: row.operationId,
    state,
    release: 'processReleased',
    nativeId: s.nativeSession?.id ?? s.uuid,
    duplicate,
  });
}

/**
 * Inspect only peers in the target's own profile and stop as soon as `minAwake` healthy peers are
 * confirmed, keeping the global `profile-policy.lock` hold minimal on large fleets.
 */
async function gatherProfilePolicyState(
  m: MachineConfig,
  target: Session,
  sessions: readonly Session[],
): Promise<{
  running: Set<string>;
  sleeping: Set<string>;
  blocked: Set<string>;
  states: Map<string, SessionHealthState>;
}> {
  const running = new Set<string>();
  const sleeping = new Set<string>();
  const blocked = new Set<string>();
  const states = new Map<string, SessionHealthState>();

  const targetProfile = sessionProfileKey(target, m);
  if (!('key' in targetProfile) || m.idleSleep.minAwakePerProfile <= 0) {
    return { running, sleeping, blocked, states };
  }

  const sameProfilePeers = sessions.filter((other) => {
    if (other.name === target.name || other.archived || other.delegation !== undefined)
      return false;
    const otherProfile = sessionProfileKey(other, m);
    return 'key' in otherProfile && otherProfile.key === targetProfile.key;
  });

  if (sameProfilePeers.some((peer) => !hasNativeRuntime(peer))) {
    try {
      const liveness = await listAgentLiveness(m);
      for (const name of liveness.live) running.add(name);
    } catch {
      /* fail closed for TUI peers when tmux cannot be queried */
    }
  }

  let confirmedHealthy = 0;
  for (const peer of sameProfilePeers) {
    if (confirmedHealthy >= m.idleSleep.minAwakePerProfile) break;
    if (readLifecycleBlockForSession(m, peer) !== null) {
      blocked.add(peer.name);
      continue;
    }
    if (sleepBlocksStart(m, peer)) {
      sleeping.add(peer.name);
      continue;
    }
    if (hasNativeRuntime(peer)) {
      const read = readManagedRuntimeStatus(m, peer);
      if (read.status === 'live' && read.snapshot !== null) {
        running.add(peer.name);
        const state: SessionHealthState =
          read.snapshot.state === 'idle'
            ? 'idle'
            : read.snapshot.state === 'working'
              ? 'working'
              : read.snapshot.state === 'waiting-approval' ||
                  read.snapshot.state === 'waiting-input'
                ? 'prompt'
                : 'unknown';
        states.set(peer.name, state);
        if (isHealthyAwakeState(state)) confirmedHealthy++;
      } else {
        states.set(peer.name, 'stopped');
      }
      continue;
    }
    if (!running.has(peer.name)) {
      states.set(peer.name, 'stopped');
      continue;
    }
    // Check peer pane health with ANSI stripped so colored menus/prompts are never misclassified.
    try {
      const styled = await capturePaneStyled(m, peer.name, 40);
      const scan = providerFor(peer).scanPane(stripAnsi(styled));
      const state: SessionHealthState =
        scan.atPrompt !== null
          ? 'prompt'
          : scan.state === 'working'
            ? 'working'
            : scan.ready
              ? 'idle'
              : 'unknown';
      states.set(peer.name, state);
      if (isHealthyAwakeState(state)) confirmedHealthy++;
    } catch {
      states.set(peer.name, 'unknown');
    }
  }
  return { running, sleeping, blocked, states };
}

export async function sleepSession(
  m: MachineConfig,
  input: z.infer<typeof SleepRequestSchema>,
  signal: AbortSignal,
  options: {
    readonly typingWindowSec?: number;
    readonly rows?: readonly ProcessSnapshot[];
  } = {},
) {
  const s = assertSleepTarget(m, input);
  await reconcileSleepRecord(m, s, { signal });
  // Strict lock hierarchy: profile-policy.lock -> admission.lock -> registry.lock.
  const admitted = await withProfilePolicyLock(
    m,
    () =>
      withNativeAdmission(
        m,
        s,
        async () => {
          signal.throwIfAborted();
          const current = assertSleepTarget(m, input);
          const prior = readSleep(m, current);
          if (prior?.operationId === input.operationId) {
            if (
              prior.proof.revision !== input.revision ||
              Boolean(prior.forcePolicy) !== Boolean(input.forcePolicy)
            ) {
              refuse('IDEMPOTENCY_CONFLICT', 'Sleep request payload changed');
            }
            if (prior.phase === 'awake' || prior.phase === 'waking') {
              refuse('SLEEP_SUPERSEDED', 'Sleep operation was followed by wake');
            }
            return { row: prior, session: current, duplicate: true };
          }
          if (prior !== null && prior.phase !== 'awake') {
            refuse('SLEEP_PENDING', 'A sleep operation is already pending');
          }

          const proof = await idleProof(m, current, {
            signal,
            ...(options.typingWindowSec === undefined
              ? {}
              : { typingWindowSec: options.typingWindowSec }),
            ...(options.rows === undefined ? {} : { rows: options.rows }),
          });
          if (proof.revision !== input.revision) refuse('REVISION_CONFLICT', 'Idle proof changed');
          if (proof.reason === 'unsupported') {
            return {
              unsupported: SleepReceiptSchema.parse({
                target: input.target,
                registrationGeneration: input.registrationGeneration,
                operationId: input.operationId,
                state: 'unchanged',
                release: 'unsupported',
                nativeId: current.nativeSession?.id ?? current.uuid,
                duplicate: false,
              }),
            };
          }
          if (!proof.eligible) refuse('NOT_IDLE', proof.reason ?? 'Idle proof unavailable');

          // Refuse sleeping an interactive Claude session whose conversation forked to a new UUID
          // before `healOnce` or `sleepSessionByName` re-pinned it (otherwise `sleep.json` would
          // land under the old UUID and wake would resume stale history).
          const allSessions = loadSessions(m);
          if (!hasNativeRuntime(current) && current.agent === 'claude') {
            const forked = forkedUuid(current, m, allSessions);
            if (forked !== null && forked !== current.uuid) {
              refuse(
                'REVISION_CONFLICT',
                'Session conversation forked; re-read identity before sleep',
              );
            }
          }

          if (input.forcePolicy !== true) {
            const needsPeerScan =
              current.pinned !== true &&
              current.delegation === undefined &&
              m.idleSleep.minAwakePerProfile > 0;
            const policyState = needsPeerScan
              ? await gatherProfilePolicyState(m, current, allSessions)
              : {
                  running: new Set<string>(),
                  sleeping: new Set<string>(),
                  blocked: new Set<string>(),
                  states: new Map<string, SessionHealthState>(),
                };
            const policy = evaluateSleepPolicy({
              m,
              session: current,
              sessions: allSessions,
              ...policyState,
              forcePolicy: false,
            });
            if (!policy.allowed) refuse(policy.code, policy.reason);
          }

          const row: SleepRecord = {
            target: input.target,
            registrationGeneration: input.registrationGeneration,
            operationId: input.operationId,
            proof,
            phase: 'requested',
            ...(input.forcePolicy === true ? { forcePolicy: true } : {}),
            updatedAt: new Date().toISOString(),
          };
          await writeSleep(m, current, row);
          return { row, session: current, duplicate: false };
        },
        signal,
      ),
    signal,
  );
  if ('unsupported' in admitted) return admitted.unsupported;
  const { row, session: activeSession, duplicate } = admitted;
  if (hasNativeRuntime(activeSession)) {
    const released = await awaitRelease(row, signal, 10_000);
    if (!released) {
      refuse('SLEEP_PENDING', 'Owned executor has not confirmed release; retry the same operation');
    }
  } else {
    await releaseTuiProcesses(m, activeSession, row, signal);
  }
  await withNativeAdmission(
    m,
    activeSession,
    async () => {
      const current = readSleep(m, activeSession);
      if (
        current?.operationId !== row.operationId ||
        !['requested', 'sleeping'].includes(current.phase)
      ) {
        refuse('SLEEP_SUPERSEDED', 'Sleep was followed by another lifecycle operation');
      }
      if (current.phase === 'requested') {
        await writeSleep(m, activeSession, {
          ...current,
          phase: 'sleeping',
          updatedAt: new Date().toISOString(),
        });
      }
    },
    signal,
  );
  return receipt(activeSession, row, 'sleeping', duplicate);
}

/**
 * Convenience CLI/daemon sleep by session name: backfills `registrationGeneration`, re-pins any
 * TUI Claude fork before computing `idleProof`, and submits one idempotent `sleepSession`.
 */
export async function sleepSessionByName(
  m: MachineConfig,
  name: string,
  options: {
    readonly forcePolicy?: boolean;
    readonly typingWindowSec?: number;
    readonly rows?: readonly ProcessSnapshot[];
    readonly signal?: AbortSignal;
  } = {},
) {
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  let session = await ensureRegistrationGeneration(m, name);
  if (session === null) {
    throw new AppError('NOT_FOUND', { message: `Unknown session '${name}'`, status: 404 });
  }
  if (session.archived) {
    refuse('ARCHIVED', `Session '${name}' is archived`);
  }
  if (!hasNativeRuntime(session) && session.agent === 'claude') {
    const nextUuid = forkedUuid(session, m, loadSessions(m));
    if (nextUuid !== null) {
      await updateSessionUuid(m, session.name, nextUuid);
      session = findSession(loadSessions(m), name) ?? { ...session, uuid: nextUuid };
    }
  }
  const registrationGeneration = session.registrationGeneration;
  if (registrationGeneration === undefined) {
    refuse('REGISTRATION_UNAVAILABLE', `Session '${name}' has no registrationGeneration`);
  }
  const proof = await idleProof(m, session, {
    signal,
    ...(options.typingWindowSec === undefined ? {} : { typingWindowSec: options.typingWindowSec }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
  });
  if (proof.reason === 'unsupported') {
    refuse('UNSUPPORTED', `Session '${name}' (${session.agent}) does not support sleep`);
  }
  if (!proof.eligible) {
    refuse('NOT_IDLE', `Session '${name}' is not idle (${proof.reason ?? 'unknown'})`);
  }
  return sleepSession(
    m,
    {
      target: managedPeer(m.rcPrefix, session),
      registrationGeneration,
      operationId: randomUUID(),
      revision: proof.revision,
      ...(options.forcePolicy === true ? { forcePolicy: true } : {}),
    },
    signal,
    {
      ...(options.typingWindowSec === undefined
        ? {}
        : { typingWindowSec: options.typingWindowSec }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
    },
  );
}
