import { existsSync, readFileSync } from 'node:fs';
import type { MachineConfig, PendingSession } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { pendingSessionsPath } from './paths.ts';
import { PendingSessionSchema } from './schema.ts';

export function loadPendingRows(m: MachineConfig): PendingSession[] {
  const path = pendingSessionsPath(m);
  if (!existsSync(path)) return [];
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return PendingSessionSchema.array().parse(value);
}

export async function writePendingRows(m: MachineConfig, pending: PendingSession[]): Promise<void> {
  await atomicWrite(pendingSessionsPath(m), `${JSON.stringify(pending, null, 2)}\n`);
}
