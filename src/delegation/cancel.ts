import { join } from 'node:path';
import { z } from 'zod';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { writePrivateJson } from '../attachments/files.ts';
import { controlTarget } from '../control/target.ts';
import { isDescendantProcess, processSnapshot } from '../external/processes.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { readRuntimeOwnership } from '../runtime/ownership.ts';
import { privateRuntimeDirectory, readPrivateJournal } from '../runtime/store.ts';
import { readSleep } from '../session/sleep/store.ts';
import type { MachineConfig, Session } from '../types.ts';
import { applicationAuthorityEnded } from './application.ts';
import { delegationRefused } from './resolve.ts';
import { DelegationCancelReceiptSchema, type DelegationCancelSchema } from './schema.ts';

const ProcessIdentitySchema = z
  .object({ pid: z.number().int().positive(), startTime: z.string() })
  .strict();
const StopSchema = z
  .object({
    operationId: z.uuid(),
    reason: z.enum(['cancelled', 'deadline', 'create-aborted']),
    at: z.iso.datetime(),
    processes: z.array(ProcessIdentitySchema).max(256).optional(),
  })
  .strict();
const stopRoot = (m: MachineConfig) => join(m.stateDir, 'control', 'delegation-stops');
const stopName = (requestId: string) => `${z.uuid().parse(requestId)}.json`;
function readStop(m: MachineConfig, requestId: string) {
  const path = join(stopRoot(m), stopName(requestId));
  const row = readPrivateJournal(path, StopSchema);
  return row;
}
export function delegationStopped(m: MachineConfig, s: Session): boolean {
  if (s.delegation === undefined) return false;
  return (
    (s.delegation.applicationAuthority !== undefined &&
      applicationAuthorityEnded(m, s.delegation.applicationAuthority)) ||
    (s.delegation.deadlineAt !== undefined && Date.now() >= Date.parse(s.delegation.deadlineAt)) ||
    readStop(m, s.delegation.requestId) !== null
  );
}
export function stopDelegationRequest(
  m: MachineConfig,
  requestId: string,
  operationId: string,
  reason: z.infer<typeof StopSchema>['reason'],
  processes?: z.infer<typeof ProcessIdentitySchema>[],
): void {
  const root = stopRoot(m);
  privateRuntimeDirectory(root);
  const prior = readStop(m, requestId);
  writePrivateJson(
    root,
    stopName(requestId),
    StopSchema.parse({
      operationId,
      reason,
      at: prior?.at ?? new Date().toISOString(),
      ...(processes === undefined
        ? prior?.processes === undefined
          ? {}
          : { processes: prior.processes }
        : { processes }),
    }),
  );
}
export async function stopDelegatedSession(
  m: MachineConfig,
  s: Session,
  operationId: string,
  reason: z.infer<typeof StopSchema>['reason'],
): Promise<void> {
  if (s.delegation === undefined) delegationRefused('Target is not a delegated child');
  stopDelegationRequest(m, s.delegation.requestId, operationId, reason);
}
export async function cancelDelegation(
  m: MachineConfig,
  input: z.infer<typeof DelegationCancelSchema>,
  signal: AbortSignal,
) {
  const s = controlTarget(m, input.target);
  if (
    s.registrationGeneration !== input.registrationGeneration ||
    s.delegation === undefined ||
    stableJson(s.delegation.parent.target) !== stableJson(input.parent.target) ||
    s.delegation.parent.registrationGeneration !== input.parent.registrationGeneration
  )
    delegationRefused('Exact parent and child registrations required');
  const requestId = s.delegation.requestId;
  const held = await withNativeAdmission(m, s, async () => {
    const ownership = readRuntimeOwnership(m, s),
      sleep = readSleep(m, s),
      prior = readStop(m, requestId);
    const rows = processSnapshot();
    const ownerLive =
      ownership !== null &&
      rows?.some(
        (row) => row.pid === ownership.owner.pid && row.startTime === ownership.owner.startTime,
      );
    const providerLive =
      ownership !== null &&
      rows?.some(
        (row) =>
          row.pid === ownership.provider.pid && row.startTime === ownership.provider.startTime,
      );
    const current =
      ownership === null || rows === null
        ? []
        : rows.filter(
            (row) =>
              (ownerLive &&
                (row.pid === ownership.owner.pid ||
                  isDescendantProcess(rows, row.pid, ownership.owner.pid))) ||
              (providerLive && row.processGroup === ownership.provider.processGroup),
          );
    const identities = [
      ...(prior?.processes ?? sleep?.proof.processes ?? ownership?.baseline ?? []),
      ...current,
    ].map(({ pid, startTime }) => ({ pid, startTime }));
    const processes = [
      ...new Map(identities.map((row) => [`${row.pid}:${row.startTime}`, row])).values(),
    ];
    // The durable stop survives a caller timeout even when ownership is not readable yet.
    stopDelegationRequest(
      m,
      requestId,
      input.operationId,
      'cancelled',
      processes.length ? processes : undefined,
    );
    return processes;
  });
  if (!held.length)
    delegationRefused('Cancellation pending; owned process evidence is unavailable');
  const deadline = Date.now() + 10000;
  for (;;) {
    signal.throwIfAborted();
    const rows = processSnapshot();
    if (
      rows !== null &&
      held.every(
        (row) => !rows.some((now) => now.pid === row.pid && now.startTime === row.startTime),
      )
    )
      return DelegationCancelReceiptSchema.parse({
        target: input.target,
        registrationGeneration: input.registrationGeneration,
        operationId: input.operationId,
        stopped: true,
      });
    if (Date.now() >= deadline) delegationRefused('Cancellation pending; retry exact operation');
    await Bun.sleep(50);
  }
}
