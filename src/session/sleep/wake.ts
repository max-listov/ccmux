import { randomUUID } from 'node:crypto';
import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { providerFor } from '../../agent/index.ts';
import { managedPeer } from '../../chat/identity.ts';
import { controlTarget } from '../../control/target.ts';
import { delegationStopped } from '../../delegation/cancel.ts';
import { withNativeAdmission } from '../../runtime/admission.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { capturePaneStyled } from '../../tmux/tmux.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { stripAnsi } from '../../util/ansi.ts';
import { readLifecycleBlockForSession } from '../lifecycleBlocks.ts';
import { ensureRegistrationGeneration } from '../registry.ts';
import { startSession } from '../start.ts';
import { listSessionPanes } from './proof.ts';
import { reconcileSleepRecord } from './reconcile.ts';
import { awaitRelease, sessionHasFreshLiveProcess } from './release.ts';
import { SleepReceiptSchema, type SleepRecord, type WakeRequestSchema } from './schema.ts';
import { readSleep, writeSleep } from './store.ts';
import { appendWakeOperation, readWakeOperations, writeWakeOperations } from './wakeStore.ts';

function refuse(code: string, message: string): never {
  throw new AppError(code, { message, status: 409 });
}

function assertWakeTarget(
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

async function rollbackWakingToSleeping(
  m: MachineConfig,
  s: Session,
  sleepOperationId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await withNativeAdmission(
      m,
      s,
      async () => {
        const current = readSleep(m, s);
        if (current?.operationId === sleepOperationId && current.phase === 'waking') {
          await writeSleep(m, s, {
            ...current,
            phase: 'sleeping',
            updatedAt: new Date().toISOString(),
          });
        }
      },
      signal,
    );
  } catch {
    /* preserve original wake error if rollback fails */
  }
}

async function acknowledgeAwake(
  m: MachineConfig,
  s: Session,
  sleepOperationId: string,
  signal: AbortSignal,
): Promise<void> {
  await withNativeAdmission(
    m,
    s,
    async () => {
      const current = readSleep(m, s);
      if (current?.operationId !== sleepOperationId) {
        refuse('SLEEP_SUPERSEDED', 'Sleep changed before wake acknowledgement');
      }
      if (current?.phase === 'waking') {
        await writeSleep(m, s, {
          ...current,
          phase: 'awake',
          updatedAt: new Date().toISOString(),
        });
      }
    },
    signal,
  );
}

/** Wake waits outside admission: native resume seeds selection under that same lock. */
async function wakeSleepingSessionWithinBudget(
  m: MachineConfig,
  s: Session,
  signal: AbortSignal,
  expectedSleepOperationId?: string,
): Promise<boolean> {
  if (delegationStopped(m, s)) refuse('DELEGATION_REFUSED', 'Delegated work has ended');
  const row = readSleep(m, s);
  if (expectedSleepOperationId !== undefined && row?.operationId !== expectedSleepOperationId) {
    refuse('SLEEP_SUPERSEDED', 'The sleep addressed by this wake has been superseded');
  }
  if (row === null || row.phase === 'awake') return false;
  const released = await awaitRelease(row, signal, 10_000);
  if (!released) {
    refuse('SLEEP_PENDING', 'Owned executor has not confirmed release; retry the same operation');
  }
  await withNativeAdmission(
    m,
    s,
    async () => {
      signal.throwIfAborted();
      if (delegationStopped(m, s)) refuse('DELEGATION_REFUSED', 'Delegated work has ended');
      const current = readSleep(m, s);
      if (current?.operationId !== row.operationId) {
        refuse('SLEEP_SUPERSEDED', 'Sleep changed before executor start');
      }
      if (current === null || current.phase === 'awake') return;
      await writeSleep(m, s, { ...current, phase: 'waking', updatedAt: new Date().toISOString() });
      await startSession(m, s.name, s.dir, signal);
    },
    signal,
  );
  let sawTmuxSession = false;
  while (true) {
    signal.throwIfAborted();
    const block = readLifecycleBlockForSession(m, s);
    if (block !== null) {
      await rollbackWakingToSleeping(m, s, row.operationId, signal);
      refuse('SESSION_BLOCKED', block.error);
    }
    if (hasNativeRuntime(s)) {
      const freshLive = await sessionHasFreshLiveProcess(m, s, row, signal);
      if (freshLive) {
        await acknowledgeAwake(m, s, row.operationId, signal);
        return true;
      }
      await Bun.sleep(100);
      continue;
    }
    // TUI wake proof: fresh (panePid, startTime), live provider child, and painted UI or prompt.
    const panes = await listSessionPanes(m, s.name, signal);
    if (panes !== null && panes.length > 0) {
      sawTmuxSession = true;
      const freshLive = await sessionHasFreshLiveProcess(m, s, row, signal);
      if (freshLive) {
        const provider = providerFor(s);
        const styled = await capturePaneStyled(m, s.name, 40);
        const scan = provider.scanPane(stripAnsi(styled));
        if (scan.ready || scan.atPrompt !== null || (s.agent !== 'claude' && s.agent !== 'codex')) {
          await acknowledgeAwake(m, s, row.operationId, signal);
          return true;
        }
      }
    } else if (sawTmuxSession) {
      await rollbackWakingToSleeping(m, s, row.operationId, signal);
      refuse('WAKE_FAILED', `Session '${s.name}' exited before becoming ready`);
    }
    await Bun.sleep(150);
  }
}

async function wakeSessionWithinBudget(
  m: MachineConfig,
  input: z.infer<typeof WakeRequestSchema>,
  signal: AbortSignal,
) {
  const s = assertWakeTarget(m, input);
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
        if (prior.sleepOperationId !== row.operationId) {
          refuse('SLEEP_SUPERSEDED', 'The sleep addressed by this wake has been superseded');
        }
      } else {
        const nextJournal = appendWakeOperation(
          journal,
          { operationId: input.operationId, sleepOperationId: row.operationId, result: null },
          row.operationId,
        );
        if (nextJournal === null) refuse('WAKE_CAPACITY', 'Wake receipt capacity reached');
        writeWakeOperations(m, s, nextJournal);
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
      if (current?.operationId !== admitted.row.operationId) {
        refuse('SLEEP_SUPERSEDED', 'Wake sleep identity changed');
      }
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
    message: 'Session has not acknowledged wake; retry',
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

/** Convenience CLI/daemon wake by session name (idempotent if already awake; strict on corrupt journal). */
export async function wakeSessionByName(
  m: MachineConfig,
  name: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<{ readonly woke: boolean; readonly session: Session }> {
  const session = await ensureRegistrationGeneration(m, name);
  if (session === null) {
    throw new AppError('NOT_FOUND', { message: `Unknown session '${name}'`, status: 404 });
  }
  if (session.archived) {
    refuse('ARCHIVED', `Session '${name}' is archived`);
  }
  const registrationGeneration = session.registrationGeneration;
  if (registrationGeneration === undefined) {
    refuse('REGISTRATION_UNAVAILABLE', `Session '${name}' has no registrationGeneration`);
  }
  // Strict read first: a corrupt sleep.json on a mutation path fails fast instead of claiming awake.
  const before = readSleep(m, session);
  if (before === null || before.phase === 'awake') {
    return { woke: false, session };
  }
  await reconcileSleepRecord(m, session, { signal });
  const current = readSleep(m, session);
  if (current === null || current.phase === 'awake') {
    return { woke: false, session };
  }
  await wakeSession(
    m,
    {
      target: managedPeer(m.rcPrefix, session),
      registrationGeneration,
      operationId: randomUUID(),
    },
    signal,
  );
  return { woke: true, session };
}
