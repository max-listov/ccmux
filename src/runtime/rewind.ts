import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { defineMailbox } from './mailbox.ts';
import { type RewindResult, RewindResultSchema } from './rewindSchema.ts';

/**
 * A request to put the files a session touched back the way they were.
 *
 * `dryRun` is carried rather than being a separate operation because the preview and the act must
 * be judged by the same code — a preview computed differently from what it previews is worse than
 * none.
 */
const RequestSchema = z
  .object({
    operationId: z.uuid(),
    generation: z.uuid(),
    messageId: z.uuid(),
    dryRun: z.boolean(),
    phase: z.enum(['queued', 'complete', 'failed']),
    result: RewindResultSchema.nullable().default(null),
    reason: z.string().max(512).nullable().default(null),
  })
  .strict();
export type RuntimeRewindRequest = z.infer<typeof RequestSchema>;

/**
 * The longest wait of any mailbox: restoring a tree touches every file a turn changed, and a
 * caller who is undoing work would rather wait than be told the runtime went quiet.
 */
const mailbox = defineMailbox<RuntimeRewindRequest, RewindResult>({
  file: 'rewind',
  schema: RequestSchema,
  identity: (receipt) => receipt.operationId,
  pollMs: 100,
  deadlineMs: 60_000,
  precondition: (snapshot) => {
    if (snapshot.fileCheckpoints !== true)
      throw new AppError('UNSUPPORTED', 'This session does not keep file checkpoints', 409);
  },
  // Answered from the receipt, unlike the mailboxes that re-read the snapshot: what a rewind did
  // exists nowhere else. There is nothing in a published snapshot to check it against.
  settle: (receipt) => {
    if (receipt.phase === 'failed')
      throw new AppError('UNAVAILABLE', receipt.reason ?? 'The rewind failed', 503);
    // Both halves, not just the result: a result present under any other phase would be a
    // half-written record, and answering from it would report a rewind that had not finished.
    return receipt.phase === 'complete' ? (receipt.result ?? undefined) : undefined;
  },
  mismatch: () => new AppError('IDENTITY_MISMATCH', 'The rewind request was replaced', 409),
});

export const readRuntimeRewind = (m: MachineConfig, s: Session) => mailbox.read(m, s);
export const writeRuntimeRewind = (m: MachineConfig, s: Session, value: RuntimeRewindRequest) =>
  mailbox.write(m, s, value);

export async function requestRuntimeRewind(
  m: MachineConfig,
  s: Session,
  input: { operationId: string; messageId: string; dryRun: boolean },
  signal: AbortSignal,
): Promise<RewindResult> {
  return mailbox.request(
    m,
    s,
    input.operationId,
    (generation) => ({
      operationId: input.operationId,
      generation,
      messageId: input.messageId,
      dryRun: input.dryRun,
      phase: 'queued',
      result: null,
      reason: null,
    }),
    signal,
  );
}
