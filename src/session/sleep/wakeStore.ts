import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from '../../attachments/files.ts';
import { refusals } from '../../control/schema/refusals.ts';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJournal } from '../../runtime/store.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { SleepReceiptSchema } from './schema.ts';

export const WAKE_JOURNAL_CAPACITY = 256;

const WakeOperationSchema = z
  .object({
    operationId: z.uuid(),
    sleepOperationId: z.uuid(),
    result: SleepReceiptSchema.nullable(),
  })
  .strict();
export type WakeOperation = z.infer<typeof WakeOperationSchema>;
const JournalSchema = z
  .object({
    registrationGeneration: z.uuid(),
    operations: z.array(WakeOperationSchema).max(WAKE_JOURNAL_CAPACITY),
  })
  .strict();

/**
 * Append a new wake operation, evicting stale incomplete entries from prior sleep cycles first and
 * then the oldest completed prior-cycle entry when the journal is full so long-lived sessions never
 * permanently hit `WAKE_CAPACITY`.
 */
export function appendWakeOperation(
  journal: readonly WakeOperation[],
  entry: WakeOperation,
  activeSleepOperationId: string,
): WakeOperation[] | null {
  if (journal.length < WAKE_JOURNAL_CAPACITY) return [...journal, entry];
  let evictIndex = journal.findIndex(
    (item) => item.result === null && item.sleepOperationId !== activeSleepOperationId,
  );
  if (evictIndex === -1) {
    evictIndex = journal.findIndex(
      (item) => item.result !== null && item.sleepOperationId !== activeSleepOperationId,
    );
  }
  if (evictIndex === -1) return null;
  return [...journal.slice(0, evictIndex), ...journal.slice(evictIndex + 1), entry];
}
export function readWakeOperations(m: MachineConfig, s: Session) {
  const path = join(managedRuntimeRoot(m, s), 'wake-operations.json');
  const rows = readPrivateJournal(path, JournalSchema, 262144);
  if (rows !== null && rows.registrationGeneration !== s.registrationGeneration)
    throw refusals.errors.IDENTITY_MISMATCH({ message: 'Wake registration changed' });
  return rows?.operations ?? [];
}
export function writeWakeOperations(
  m: MachineConfig,
  s: Session,
  rows: Array<z.infer<typeof WakeOperationSchema>>,
): void {
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  writePrivateJson(
    managedRuntimeRoot(m, s),
    'wake-operations.json',
    JournalSchema.parse({
      registrationGeneration: s.registrationGeneration,
      operations: rows,
    }),
  );
}
