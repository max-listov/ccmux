import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from './status.ts';
import { readPrivateJson } from './store.ts';

const InterruptSchema = z
  .object({
    generation: z.uuid(),
    turnId: z.string().min(1).max(256),
    phase: z.enum(['queued', 'uncertain', 'accepted', 'rejected']),
  })
  .strict();
export type RuntimeInterrupt = z.infer<typeof InterruptSchema>;
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'interrupt.json');
export const readRuntimeInterrupt = (m: MachineConfig, s: Session) =>
  readPrivateJson(path(m, s), InterruptSchema);
export const writeRuntimeInterrupt = (m: MachineConfig, s: Session, value: RuntimeInterrupt) =>
  atomicWrite(path(m, s), JSON.stringify(InterruptSchema.parse(value)), 0o600);

export async function requestRuntimeInterrupt(
  m: MachineConfig,
  s: Session,
  turnId: string,
  signal: AbortSignal,
): Promise<void> {
  const read = readManagedRuntimeStatus(m, s);
  if (
    read.status !== 'live' ||
    read.snapshot?.turn?.id !== turnId ||
    read.snapshot.state !== 'working' ||
    read.snapshot.turn.status !== 'inProgress'
  )
    throw new AppError('TURN_MISMATCH', 'The exact working turn is unavailable', 409);
  const generation = read.snapshot.generation;
  const prior = readRuntimeInterrupt(m, s);
  if (prior?.generation !== generation || prior.turnId !== turnId)
    await writeRuntimeInterrupt(m, s, { generation, turnId, phase: 'queued' });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const receipt = readRuntimeInterrupt(m, s);
    if (receipt?.generation !== generation || receipt.turnId !== turnId)
      throw new AppError('TURN_MISMATCH', 'Interrupt identity changed', 409);
    if (receipt.phase === 'accepted') return;
    if (receipt.phase === 'rejected')
      throw new AppError('TURN_MISMATCH', 'Native turn changed', 409);
    await Bun.sleep(25);
  }
  throw new AppError('UNAVAILABLE', 'Native interrupt acknowledgement is unavailable', 503);
}
