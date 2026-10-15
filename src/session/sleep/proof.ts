import { createHash } from 'node:crypto';
import { stableJson } from '../../agent/launch/launchInputs.ts';
import { loadAcks } from '../../chat/ackLog.ts';
import { loadCursors } from '../../chat/cursors.ts';
import { managedPeer, managedPeerKey, sameTarget } from '../../chat/identity.ts';
import { loadLedger } from '../../chat/ledger.ts';
import { letterState } from '../../chat/settlement.ts';
import { contextMutationPending } from '../../context/store.ts';
import { delegationStopped } from '../../delegation/cancel.ts';
import { isDescendantProcess, processSnapshot } from '../../external/processes.ts';
import { readRuntimeInput } from '../../runtime/input.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { readRuntimeOwnership } from '../../runtime/ownership.ts';
import { readManagedRuntimeStatus } from '../../runtime/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { loadSessions } from '../registry.ts';
import { IdleProofSchema } from './schema.ts';

export function idleProof(m: MachineConfig, s: Session) {
  const target = managedPeer(m.rcPrefix, s);
  const read = readManagedRuntimeStatus(m, s);
  const snapshot = read.snapshot;
  const rows = processSnapshot();
  const owner = rows?.find((row) => row.pid === snapshot?.pid);
  const provider = rows?.find((row) => row.pid === snapshot?.providerPid);
  const ownership = readRuntimeOwnership(m, s);
  const owned =
    ownership !== null &&
    ownership.owner.pid === owner?.pid &&
    ownership.owner.startTime === owner?.startTime &&
    ownership.provider.pid === provider?.pid &&
    ownership.provider.startTime === provider?.startTime &&
    owner !== undefined &&
    provider !== undefined &&
    (provider.pid === owner.pid || isDescendantProcess(rows ?? [], provider.pid, owner.pid));
  const processes =
    rows?.filter(
      (row) =>
        row.pid === owner?.pid ||
        row.processGroup === ownership?.provider.processGroup ||
        (owner !== undefined && isDescendantProcess(rows, row.pid, owner.pid)),
    ) ?? [];
  const background =
    !owned || rows === null
      ? null
      : processes.filter(
          (row) =>
            !ownership.baseline.some(
              (known) => known.pid === row.pid && known.startTime === row.startTime,
            ),
        ).length;
  const cursors = loadCursors(m),
    acks = loadAcks(m);
  const ledger = loadLedger(m);
  const pending = ledger.flatMap((message, index) =>
    message !== null &&
    sameTarget(message.to, target) &&
    letterState(message, index, acks, cursors) === 'pending'
      ? [message.id]
      : [],
  );
  const children = loadSessions(m).filter(
    (child) =>
      !child.archived &&
      !delegationStopped(m, child) &&
      child.delegation !== undefined &&
      child.delegation.parent.target.kind === 'managed' &&
      sameTarget(child.delegation.parent.target, target) &&
      child.delegation.parent.registrationGeneration === s.registrationGeneration,
  );
  const input = readRuntimeInput(m, s);
  const run =
    read.status !== 'live' || snapshot === null
      ? 'unknown'
      : snapshot.state === 'idle' && snapshot.turn?.status !== 'inProgress'
        ? 'idle'
        : 'active';
  const approvals = snapshot?.pendingRequests.length ?? null;
  const reason =
    !hasNativeRuntime(s) || !['codex', 'claude'].includes(s.agent)
      ? 'unsupported'
      : delegationStopped(m, s)
        ? 'delegation-ended'
        : s.delegation === undefined
          ? 'unbounded-native-background-state'
          : s.registrationGeneration === undefined
            ? 'registration-unavailable'
            : !owned
              ? 'owner-unavailable'
              : run !== 'idle'
                ? 'runtime-not-idle'
                : pending.length || cursors.pickups[managedPeerKey(target)] !== undefined
                  ? 'queued-input'
                  : input !== null && input.phase !== 'accepted'
                    ? 'dispatch-pending'
                    : approvals !== 0
                      ? 'pending-requests'
                      : children.length
                        ? 'owned-children'
                        : background === null || background > 0
                          ? 'background-processes'
                          : contextMutationPending(m, s)
                            ? 'context-operation'
                            : null;
  const facts = {
    target,
    registrationGeneration: s.registrationGeneration,
    generation: snapshot?.generation ?? null,
    run,
    pending,
    input,
    approvals,
    children: children.map((child) => [child.uuid, child.registrationGeneration]),
    background,
    processes: processes.map(({ pid, startTime }) => ({ pid, startTime })),
  };
  return IdleProofSchema.parse({
    target,
    registrationGeneration: s.registrationGeneration,
    revision: createHash('sha256').update(stableJson(facts)).digest('hex'),
    generation: snapshot?.generation ?? null,
    observedAt: new Date().toISOString(),
    eligible: reason === null,
    reason,
    run,
    queue: pending.length,
    approvals,
    children: children.length,
    background,
    processes: facts.processes,
  });
}
