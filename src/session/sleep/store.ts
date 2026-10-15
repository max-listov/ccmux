import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJournal } from '../../runtime/store.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { type SleepRecord, SleepRecordSchema } from './schema.ts';

const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'sleep.json');
export function readSleep(m: MachineConfig, s: Session): SleepRecord | null {
  const file = path(m, s);
  const row = readPrivateJournal(file, SleepRecordSchema, 65536);
  if (
    row !== null &&
    (row.target.threadId !== s.uuid || row.registrationGeneration !== s.registrationGeneration)
  )
    throw new AppError('IDENTITY_MISMATCH', { message: 'Sleep registration changed', status: 409 });
  return row;
}
export async function writeSleep(m: MachineConfig, s: Session, row: SleepRecord): Promise<void> {
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  await atomicWrite(path(m, s), JSON.stringify(SleepRecordSchema.parse(row)), 0o600);
}
export function sleepBlocksStart(m: MachineConfig, s: Session): boolean {
  const row = readSleep(m, s);
  return row !== null && row.phase !== 'awake' && row.phase !== 'waking';
}
/** Read by the owner itself; no process selected by name is ever signalled. */
export function ownerShouldSleep(m: MachineConfig, s: Session): boolean {
  const row = readSleep(m, s);
  return (
    row?.phase === 'requested' && row.proof.processes.some((entry) => entry.pid === process.pid)
  );
}
