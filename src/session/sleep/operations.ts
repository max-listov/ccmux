import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { controlTarget } from '../../control/target.ts';
import { delegationStopped } from '../../delegation/cancel.ts';
import { processSnapshot } from '../../external/processes.ts';
import { withNativeAdmission } from '../../runtime/admission.ts';
import { readManagedRuntimeStatus } from '../../runtime/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { startSession } from '../start.ts';
import { idleProof } from './proof.ts';
import {
  SleepReceiptSchema,
  type SleepRecord,
  type SleepRequestSchema,
  type WakeRequestSchema,
} from './schema.ts';
import { readSleep, writeSleep } from './store.ts';
import { readWakeOperations, writeWakeOperations } from './wakeStore.ts';

function refuse(code: string, message: string): never {
  throw new AppError(code, { message, status: 409 });
}
export function assertSleepTarget(
  m: MachineConfig,
  input: { target: Parameters<typeof controlTarget>[1]; registrationGeneration: string },
) {
  const s = controlTarget(m, input.target);
  if (s.archived || s.registrationGeneration !== input.registrationGeneration)
    refuse('IDENTITY_MISMATCH', 'Exact active registration required');
  return s;
}
export function processesReleased(row: SleepRecord): boolean {
  const processes = processSnapshot();
  return (
    processes !== null &&
    row.proof.processes.every(
      (held) =>
        !processes.some(
          (current) => held.pid === current.pid && held.startTime === current.startTime,
        ),
    )
  );
}
async function awaitRelease(row: SleepRecord, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!processesReleased(row)) {
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      refuse('SLEEP_PENDING', 'Owned executor has not confirmed release; retry the same operation');
    await Bun.sleep(50);
  }
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
export async function sleepSession(
  m: MachineConfig,
  input: z.infer<typeof SleepRequestSchema>,
  signal: AbortSignal,
) {
  const s = assertSleepTarget(m, input);
  const admitted = await withNativeAdmission(m, s, async () => {
    signal.throwIfAborted();
    const current = assertSleepTarget(m, input);
    const prior = readSleep(m, current);
    if (prior?.operationId === input.operationId) {
      if (prior.proof.revision !== input.revision)
        refuse('IDEMPOTENCY_CONFLICT', 'Sleep request payload changed');
      if (prior.phase === 'awake' || prior.phase === 'waking')
        refuse('SLEEP_SUPERSEDED', 'Sleep operation was followed by wake');
      return { row: prior, duplicate: true };
    }
    if (prior !== null && prior.phase !== 'awake')
      refuse('SLEEP_PENDING', 'A sleep operation is already pending');
    const proof = idleProof(m, current);
    if (proof.revision !== input.revision) refuse('REVISION_CONFLICT', 'Idle proof changed');
    if (proof.reason === 'unsupported' || proof.reason === 'unbounded-native-background-state')
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
    if (!proof.eligible) refuse('NOT_IDLE', proof.reason ?? 'Idle proof unavailable');
    const row: SleepRecord = {
      target: input.target,
      registrationGeneration: input.registrationGeneration,
      operationId: input.operationId,
      proof,
      phase: 'requested',
      updatedAt: new Date().toISOString(),
    };
    await writeSleep(m, current, row);
    return { row, duplicate: false };
  });
  if ('unsupported' in admitted) return admitted.unsupported;
  const { row, duplicate } = admitted;
  await awaitRelease(row, signal);
  await withNativeAdmission(m, s, async () => {
    const current = readSleep(m, s);
    if (
      current?.operationId !== row.operationId ||
      !['requested', 'sleeping'].includes(current.phase)
    )
      refuse('SLEEP_SUPERSEDED', 'Sleep was followed by another lifecycle operation');
    if (current.phase === 'requested')
      await writeSleep(m, s, {
        ...current,
        phase: 'sleeping',
        updatedAt: new Date().toISOString(),
      });
  });
  return receipt(s, row, 'sleeping', duplicate);
}
/** Wake waits outside admission: native resume seeds selection under that same lock. */
async function wakeSleepingSessionWithinBudget(
  m: MachineConfig,
  s: Session,
  signal: AbortSignal,
  expectedSleepOperationId?: string,
) {
  // Wake is durable: bound the synchronous wait and let the same operation retry a cold start.

  if (delegationStopped(m, s)) refuse('DELEGATION_REFUSED', 'Delegated work has ended');
  const row = readSleep(m, s);
  if (expectedSleepOperationId !== undefined && row?.operationId !== expectedSleepOperationId)
    refuse('SLEEP_SUPERSEDED', 'The sleep addressed by this wake has been superseded');
  if (row === null || row.phase === 'awake') return false;
  await awaitRelease(row, signal);
  await withNativeAdmission(
    m,
    s,
    async () => {
      signal.throwIfAborted();
      if (delegationStopped(m, s)) refuse('DELEGATION_REFUSED', 'Delegated work has ended');
      const current = readSleep(m, s);
      if (current?.operationId !== row.operationId)
        refuse('SLEEP_SUPERSEDED', 'Sleep changed before executor start');
      if (current === null || current.phase === 'awake') return;
      await writeSleep(m, s, { ...current, phase: 'waking', updatedAt: new Date().toISOString() });
      await startSession(m, s.name, s.dir, signal);
    },
    signal,
  );
  while (true) {
    signal.throwIfAborted();
    const read = readManagedRuntimeStatus(m, s);
    if (
      read.status === 'live' &&
      read.snapshot !== null &&
      !row.proof.processes.some((held) => held.pid === read.snapshot?.pid)
    ) {
      await withNativeAdmission(
        m,
        s,
        async () => {
          const current = readSleep(m, s);
          if (current?.operationId !== row.operationId)
            refuse('SLEEP_SUPERSEDED', 'Sleep changed before wake acknowledgement');
          if (current?.phase === 'waking')
            await writeSleep(m, s, {
              ...current,
              phase: 'awake',
              updatedAt: new Date().toISOString(),
            });
        },
        signal,
      );
      return true;
    }
    await Bun.sleep(50);
  }
}
async function wakeSessionWithinBudget(
  m: MachineConfig,
  input: z.infer<typeof WakeRequestSchema>,
  signal: AbortSignal,
) {
  const s = assertSleepTarget(m, input);
  const admitted = await withNativeAdmission(
    m,
    s,
    async () => {
      const row = readSleep(m, s);
      if (row === null) refuse('NOT_SLEEPING', 'Session has no sleep receipt');
      const journal = readWakeOperations(m, s);
      const prior = journal.find((record) => record.operationId === input.operationId);
      if (prior !== undefined) {
        if (prior.result !== null) return { row, result: prior.result };
        if (prior.sleepOperationId !== row.operationId)
          refuse('SLEEP_SUPERSEDED', 'The sleep addressed by this wake has been superseded');
      } else {
        if (journal.length >= 256) refuse('WAKE_CAPACITY', 'Wake receipt capacity reached');
        writeWakeOperations(m, s, [
          ...journal,
          { operationId: input.operationId, sleepOperationId: row.operationId, result: null },
        ]);
      }
      return { row, result: null };
    },
    signal,
  );
  if (admitted.result !== null) return { ...admitted.result, duplicate: true };
  await wakeSleepingSessionWithinBudget(m, s, signal, admitted.row.operationId);
  return withNativeAdmission(
    m,
    s,
    async () => {
      const current = readSleep(m, s);
      if (current?.operationId !== admitted.row.operationId)
        refuse('SLEEP_SUPERSEDED', 'Wake sleep identity changed');
      const result = {
        ...receipt(s, admitted.row, 'awake', false),
        operationId: input.operationId,
      };
      const journal = readWakeOperations(m, s);
      writeWakeOperations(
        m,
        s,
        journal.map((record) =>
          record.operationId === input.operationId ? { ...record, result } : record,
        ),
      );
      return result;
    },
    signal,
  );
}

/** One abortable budget covers admission, process release, tmux launch and acknowledgement. */
async function withinWakeBudget<T>(
  m: MachineConfig,
  caller: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const pending = new AppError('WAKE_PENDING', {
    message: 'Native continuation has not acknowledged wake; retry',
    status: 409,
  });
  const timer = setTimeout(
    () => controller.abort(pending),
    Math.min(m.codexCorrelationTimeoutMs + 1000, 25000),
  );
  const signal = AbortSignal.any([caller, controller.signal]);
  try {
    return await work(signal);
  } finally {
    clearTimeout(timer);
  }
}
export function wakeSleepingSession(
  m: MachineConfig,
  s: Session,
  signal: AbortSignal,
  expectedSleepOperationId?: string,
) {
  return withinWakeBudget(m, signal, (bounded) =>
    wakeSleepingSessionWithinBudget(m, s, bounded, expectedSleepOperationId),
  );
}
export function wakeSession(
  m: MachineConfig,
  input: z.infer<typeof WakeRequestSchema>,
  signal: AbortSignal,
) {
  return withinWakeBudget(m, signal, (bounded) => wakeSessionWithinBudget(m, input, bounded));
}
