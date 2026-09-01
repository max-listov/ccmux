import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { OwnedCodexSnapshot } from '../agent/codex/ownedSchema.ts';
import type { MachineConfig, Session } from '../types.ts';
import { defineMailbox } from './mailbox.ts';
import { readManagedRuntimeStatus } from './status.ts';

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

/**
 * Stop the turn that is running.
 *
 * Its operation is the turn: two callers asking to stop the same turn are asking for one thing, so
 * the turn's id is what makes a retry the same request. Its phases keep a fourth value the other
 * mailboxes do not have — `uncertain`, written by an adapter whose cancel was sent and whose
 * acknowledgement was lost. That is neither done nor refused, and reporting it as either would tell
 * a caller a turn stopped when nobody knows.
 */
const InterruptSchema = z
  .object({
    turnId: z.string().min(1).max(256),
    generation: z.uuid(),
    phase: z.enum(['queued', 'uncertain', 'accepted', 'rejected']),
  })
  .strict();
export type RuntimeInterrupt = z.infer<typeof InterruptSchema>;

/**
 * The shortest wait and the tightest poll of any mailbox: a person is holding a key down waiting
 * for a turn to stop, and a cancel that takes five seconds to confirm has already failed them.
 */
const mailbox = defineMailbox<RuntimeInterrupt, true>({
  file: 'interrupt',
  schema: InterruptSchema,
  identity: (receipt) => receipt.turnId,
  pollMs: 25,
  deadlineMs: 5_000,
  settle: (receipt) => {
    if (receipt.phase === 'rejected')
      throw new AppError('TURN_MISMATCH', 'Native turn changed', 409);
    // `uncertain` deliberately keeps polling: the adapter said it does not know, and the deadline
    // below is what turns that into an honest 503 rather than a made-up answer.
    return receipt.phase === 'accepted' ? true : undefined;
  },
  mismatch: () => new AppError('TURN_MISMATCH', 'Interrupt identity changed', 409),
});

export const readRuntimeInterrupt = (m: MachineConfig, s: Session) => mailbox.read(m, s);
export const writeRuntimeInterrupt = (m: MachineConfig, s: Session, value: RuntimeInterrupt) =>
  mailbox.write(m, s, value);

export async function requestRuntimeInterrupt(
  m: MachineConfig,
  s: Session,
  generation: string,
  turnId: string,
  signal: AbortSignal,
): Promise<void> {
  const read = readManagedRuntimeStatus(m, s);
  const prior = readRuntimeInterrupt(m, s);
  // Already stopped by this same request: answered without asking again. A second interrupt aimed
  // at a turn that is no longer running would be refused as a mismatch, which is the wrong answer
  // to "did my cancel take".
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
  await mailbox.request(m, s, turnId, () => ({ turnId, generation, phase: 'queued' }), signal);
}
