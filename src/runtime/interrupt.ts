import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { OwnedCodexSnapshot } from '../agent/codex/ownedSchema.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from './status.ts';
import { readPrivateJson } from './store.ts';

export function isCancellableTurn(
  snapshot: Pick<OwnedCodexSnapshot, 'generation' | 'state' | 'turn'>,
  generation: string,
  turnId: string,
): boolean {
  return (
    snapshot.generation === generation &&
    snapshot.turn?.id === turnId &&
    snapshot.turn.status === 'inProgress' &&
    ['working', 'waiting-approval', 'waiting-input'].includes(snapshot.state)
  );
}

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
  generation: string,
  turnId: string,
  signal: AbortSignal,
): Promise<void> {
  const read = readManagedRuntimeStatus(m, s);
  const prior = readRuntimeInterrupt(m, s);
  if (
    read.status === 'live' &&
    read.snapshot?.generation === generation &&
    prior?.generation === generation &&
    prior.turnId === turnId &&
    prior.phase === 'accepted'
  )
    return;
  if (
    read.status !== 'live' ||
    !read.snapshot ||
    !isCancellableTurn(read.snapshot, generation, turnId)
  )
    throw new AppError('TURN_MISMATCH', 'The exact active turn is unavailable', 409);
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
