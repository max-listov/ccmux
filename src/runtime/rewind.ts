import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { type RewindResult, RewindResultSchema } from './rewindSchema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from './status.ts';
import { readPrivateJson } from './store.ts';

/**
 * A request to put the files a session touched back the way they were.
 *
 * Durable between the caller and the process that holds the connection, like the mode request
 * beside it. `dryRun` is carried rather than being a separate operation because the preview and the
 * act must be judged by the same code — a preview computed differently from what it previews is
 * worse than none.
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

const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'rewind.json');
export const readRuntimeRewind = (m: MachineConfig, s: Session) =>
  readPrivateJson(path(m, s), RequestSchema);
export const writeRuntimeRewind = (m: MachineConfig, s: Session, value: RuntimeRewindRequest) =>
  atomicWrite(path(m, s), JSON.stringify(RequestSchema.parse(value)), 0o600);

export async function requestRuntimeRewind(
  m: MachineConfig,
  s: Session,
  input: { operationId: string; messageId: string; dryRun: boolean },
  signal: AbortSignal,
): Promise<RewindResult> {
  const read = readManagedRuntimeStatus(m, s);
  if (read.status !== 'live' || !read.snapshot)
    throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
  if (read.snapshot.fileCheckpoints !== true)
    throw new AppError('UNSUPPORTED', 'This session does not keep file checkpoints', 409);
  const generation = read.snapshot.generation;
  const prior = readRuntimeRewind(m, s);
  // The same operation asked twice is one rewind. Repeating a real one would restore files over
  // work done since the first, which is the opposite of undo.
  if (prior?.operationId === input.operationId && prior.generation === generation) {
    if (prior.phase === 'complete' && prior.result !== null) return prior.result;
    if (prior.phase === 'failed')
      throw new AppError('UNAVAILABLE', prior.reason ?? 'The rewind failed', 503);
  } else
    await writeRuntimeRewind(m, s, {
      operationId: input.operationId,
      generation,
      messageId: input.messageId,
      dryRun: input.dryRun,
      phase: 'queued',
      result: null,
      reason: null,
    });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const current = readRuntimeRewind(m, s);
    if (current?.operationId !== input.operationId || current.generation !== generation)
      throw new AppError('IDENTITY_MISMATCH', 'The rewind request was replaced', 409);
    if (current.phase === 'failed')
      throw new AppError('UNAVAILABLE', current.reason ?? 'The rewind failed', 503);
    if (current.phase === 'complete' && current.result !== null) return current.result;
    await Bun.sleep(100);
  }
  throw new AppError('UNAVAILABLE', 'The runtime did not answer the rewind request', 503);
}
