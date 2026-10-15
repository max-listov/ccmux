import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { writePrivateJson } from '../../attachments/files.ts';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJournal } from '../../runtime/store.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { SleepReceiptSchema } from './schema.ts';

const WakeOperationSchema = z
  .object({
    operationId: z.uuid(),
    sleepOperationId: z.uuid(),
    result: SleepReceiptSchema.nullable(),
  })
  .strict();
const JournalSchema = z
  .object({
    registrationGeneration: z.uuid(),
    operations: z.array(WakeOperationSchema).max(256),
  })
  .strict();
export function readWakeOperations(m: MachineConfig, s: Session) {
  const path = join(managedRuntimeRoot(m, s), 'wake-operations.json');
  const rows = readPrivateJournal(path, JournalSchema, 262144);
  if (rows !== null && rows.registrationGeneration !== s.registrationGeneration)
    throw new AppError('IDENTITY_MISMATCH', { message: 'Wake registration changed', status: 409 });
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
