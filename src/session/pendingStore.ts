import { existsSync, readFileSync } from 'node:fs';
import { pendingSessionsPath } from '../config/paths.ts';
import type { MachineConfig, PendingSession } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { FileSnapshot } from '../util/fileSnapshot.ts';
import { producerMetrics } from '../util/producerMetrics.ts';
import { PendingSessionSchema } from './schema.ts';

const PendingRowsSchema = PendingSessionSchema.array();
const pendingFile = new FileSnapshot<PendingSession[]>();
export const pendingFileMetrics = () => pendingFile.metrics();
producerMetrics.register('pendingFile', pendingFileMetrics);

export function loadPendingRows(m: MachineConfig): PendingSession[] {
  const path = pendingSessionsPath(m);
  return pendingFile.read(path, () => {
    if (!existsSync(path)) return [];
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return PendingRowsSchema.parse(value);
  });
}

export async function writePendingRows(m: MachineConfig, pending: PendingSession[]): Promise<void> {
  await atomicWrite(pendingSessionsPath(m), `${JSON.stringify(pending, null, 2)}\n`);
}
