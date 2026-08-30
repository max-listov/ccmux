import { randomUUID } from 'node:crypto';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { blockingInbound } from '../commands/wait.ts';
import { withDirectoryLock } from '../config/registryLock.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { readRuntimeInput } from '../runtime/input.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../runtime/status.ts';
import { readPrivateJson } from '../runtime/store.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import {
  type CompactRequest,
  CompactRequestSchema,
  ContextOperationSchema,
  HISTORY_LIMITS,
  NativeHistoryPageSchema,
  type NativeHistoryQuery,
  NativeHistoryQuerySchema,
} from './schema.ts';
import {
  assertNoContextMutation,
  contextPath,
  readContextJournal,
  withContextJournal,
} from './store.ts';

export const HistoryMailboxSchema = z
  .object({
    id: z.uuid(),
    generation: z.uuid(),
    expiresAt: z.number(),
    query: NativeHistoryQuerySchema,
    state: z.enum(['queued', 'complete', 'failed']),
    page: NativeHistoryPageSchema.nullable(),
    error: z.enum(['HISTORY_CURSOR', 'HISTORY_UNAVAILABLE']).nullable().default(null),
  })
  .strict();
export const readHistoryMailbox = (m: MachineConfig, s: Session) =>
  readPrivateJson(
    contextPath(m, s, 'history-read.json'),
    HistoryMailboxSchema,
    HISTORY_LIMITS.fileBytes,
  );
export const writeHistoryMailbox = (
  m: MachineConfig,
  s: Session,
  value: z.infer<typeof HistoryMailboxSchema>,
) =>
  atomicWrite(
    contextPath(m, s, 'history-read.json'),
    JSON.stringify(HistoryMailboxSchema.parse(value)),
    0o600,
  );

/** Serialized bounded read requests are executed by the existing owner connection, never a new writer. */
export async function readNativeHistory(
  m: MachineConfig,
  s: Session,
  query: NativeHistoryQuery,
  signal: AbortSignal,
) {
  const parsed = NativeHistoryQuerySchema.parse(query);
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  return withDirectoryLock(
    contextPath(m, s, 'history-reader.lock'),
    async () => {
      const status = readManagedRuntimeStatus(m, s);
      if (status.status !== 'live' || !status.snapshot)
        throw new AppError('HISTORY_UNAVAILABLE', 'Native history is unavailable', 503);
      signal.throwIfAborted();
      const request = HistoryMailboxSchema.parse({
        id: randomUUID(),
        generation: status.snapshot.generation,
        expiresAt: Date.now() + HISTORY_LIMITS.deadlineMs,
        query: parsed,
        state: 'queued',
        page: null,
      });
      await writeHistoryMailbox(m, s, request);
      while (Date.now() < request.expiresAt) {
        signal.throwIfAborted();
        const response = readHistoryMailbox(m, s);
        if (response?.id !== request.id)
          throw new AppError('HISTORY_UNAVAILABLE', 'Native history request changed', 503);
        if (response.state === 'complete' && response.page !== null) return response.page;
        if (response.state === 'failed') {
          if (response.error === 'HISTORY_CURSOR')
            throw new AppError(
              'HISTORY_CURSOR',
              'Native history cursor is invalid or no longer current',
              409,
            );
          throw new AppError(
            'HISTORY_UNAVAILABLE',
            'Native history could not be read within its limits',
            503,
          );
        }
        await Bun.sleep(20);
      }
      throw new AppError('HISTORY_UNAVAILABLE', 'Native history deadline exceeded', 503);
    },
    'native history reader',
  );
}

export async function compactNativeContext(
  m: MachineConfig,
  s: Session,
  request: CompactRequest,
  signal: AbortSignal,
) {
  const parsed = CompactRequestSchema.parse(request);
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  return withNativeAdmission(m, s, () =>
    withContextJournal(m, s, async (journal, persist) => {
      const prior = journal.operations.find((row) => row.operationId === parsed.operationId);
      if (prior) {
        if (prior.generation !== parsed.generation)
          throw new AppError('CONTEXT_CONFLICT', 'Native context operation identity changed', 409);
        return prior;
      }
      signal.throwIfAborted();
      assertNoContextMutation(m, s);
      const status = readManagedRuntimeStatus(m, s);
      if (
        status.status !== 'live' ||
        status.snapshot?.generation !== parsed.generation ||
        status.snapshot.state !== 'idle' ||
        status.snapshot.turn?.status === 'inProgress' ||
        status.snapshot.pendingRequests.length !== 0
      )
        throw new AppError('CONTEXT_BUSY', 'Native context is not idle', 409);
      const input = readRuntimeInput(m, s);
      if (
        blockingInbound(m, s, Date.now()).length !== 0 ||
        (input !== null && input.phase !== 'accepted')
      )
        throw new AppError('CONTEXT_BUSY', 'Native context has accepted input pending', 409);
      if (journal.operations.length >= 256)
        throw new AppError('CONTEXT_CAPACITY', 'Native context operation capacity reached', 409);
      const operation = ContextOperationSchema.parse({
        ...parsed,
        state: 'queued',
        revision: journal.revision,
        markerBefore: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      journal.operations.push(operation);
      await persist();
      return operation;
    }),
  );
}
export const readContextOperation = (m: MachineConfig, s: Session, operationId: string) =>
  readContextJournal(m, s).operations.find((row) => row.operationId === operationId) ?? null;

/** Deprecated history-only rollback and workspace-changing revert are not safe substitutes. */
export function refuseNativeRollback(): never {
  throw new AppError(
    'ROLLBACK_UNSUPPORTED',
    'Native rollback cannot guarantee conversation and workspace safety',
    409,
  );
}
