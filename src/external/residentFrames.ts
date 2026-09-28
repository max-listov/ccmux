import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { type ExternalStatusSnapshot, ExternalStatusSnapshotSchema } from './residentSchema.ts';

/**
 * The external status stream, carried by change.
 *
 * The observer republishes every two seconds, and between two passes of a quiet machine nothing
 * moves but the clock: the snapshot's `observedAt`/`expiresAt` and each row's turn-state times,
 * which are that same pass's times. Sending the whole snapshot to say "still true, for five more
 * seconds" made this stream the largest flow from a quiet node. So a reader gets the whole snapshot
 * when it opens the stream and whenever its content changes, and in between a renewal: the new
 * sequence and times, applied to the snapshot it already holds.
 *
 * A renewal is emitted only when applying it reproduces the new snapshot exactly — the encoder
 * checks that with the reader's own function — so the rebuilt snapshot is the published one, not an
 * approximation of it. It names the sequence it follows: a reader holding anything else (it missed
 * a line, or reopened) cannot apply it and must reopen, and a reopened stream starts with a snapshot.
 */
export const ExternalStatusRenewalSchema = z
  .object({
    frame: z.literal('renewal'),
    generation: z.uuid(),
    /** The sequence the reader must hold for this renewal to apply. */
    after: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    observedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ExternalStatusRenewal = z.infer<typeof ExternalStatusRenewalSchema>;

export const ExternalStatusFrameSchema = z.discriminatedUnion('frame', [
  z.object({ frame: z.literal('snapshot'), snapshot: ExternalStatusSnapshotSchema }).strict(),
  ExternalStatusRenewalSchema,
]);
export type ExternalStatusFrame = z.infer<typeof ExternalStatusFrameSchema>;

/**
 * The snapshot a frame leaves the reader holding; null when a renewal does not follow what it holds
 * — the reader then reopens the stream rather than extend a snapshot it does not have.
 *
 * A renewal moves the snapshot's times, and each row's turn-state times that were the snapshot's
 * own; a row observed at another moment keeps its times.
 */
export function applyExternalStatusFrame(
  held: ExternalStatusSnapshot | null,
  frame: ExternalStatusFrame,
): ExternalStatusSnapshot | null {
  if (frame.frame === 'snapshot') return frame.snapshot;
  if (held === null || held.generation !== frame.generation || held.sequence !== frame.after)
    return null;
  return {
    ...held,
    sequence: frame.sequence,
    observedAt: frame.observedAt,
    expiresAt: frame.expiresAt,
    sessions: held.sessions.map((row) =>
      row.turnState.observedAt === held.observedAt && row.turnState.expiresAt === held.expiresAt
        ? {
            ...row,
            turnState: {
              ...row.turnState,
              observedAt: frame.observedAt,
              expiresAt: frame.expiresAt,
            },
          }
        : row,
    ),
  };
}

/** One stream's encoder: the first snapshot whole, then a renewal wherever one reproduces it. */
export function createExternalStatusEncoder(): (
  snapshot: ExternalStatusSnapshot,
) => ExternalStatusFrame {
  let held: ExternalStatusSnapshot | null = null;
  return (snapshot) => {
    if (held !== null) {
      const renewal: ExternalStatusRenewal = {
        frame: 'renewal',
        generation: snapshot.generation,
        after: held.sequence,
        sequence: snapshot.sequence,
        observedAt: snapshot.observedAt,
        expiresAt: snapshot.expiresAt,
      };
      if (isDeepStrictEqual(applyExternalStatusFrame(held, renewal), snapshot)) {
        held = snapshot;
        return renewal;
      }
    }
    held = snapshot;
    return { frame: 'snapshot', snapshot };
  };
}
