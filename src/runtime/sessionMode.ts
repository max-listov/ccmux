import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { type PermissionMode, PermissionModeSchema } from './projectionSchema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from './status.ts';
import { readPrivateJson } from './store.ts';

/**
 * The requested permission mode, durable between the caller and the session that owns the runtime.
 *
 * Shaped like the interrupt mailbox rather than like the input one: this is a setting, not a turn.
 * It carries a generation so a request written for one conversation can never be applied to the
 * conversation that replaced it, and a phase so a caller can tell "asked" from "the runtime agreed".
 */
const ModeRequestSchema = z
  .object({
    generation: z.uuid(),
    mode: PermissionModeSchema,
    phase: z.enum(['queued', 'accepted', 'rejected']),
    reason: z.string().max(256).nullable().default(null),
  })
  .strict();
export type RuntimeModeRequest = z.infer<typeof ModeRequestSchema>;

const path = (m: MachineConfig, s: Session) =>
  join(managedRuntimeRoot(m, s), 'permission-mode.json');
export const readRuntimeMode = (m: MachineConfig, s: Session) =>
  readPrivateJson(path(m, s), ModeRequestSchema);
export const writeRuntimeMode = (m: MachineConfig, s: Session, value: RuntimeModeRequest) =>
  atomicWrite(path(m, s), JSON.stringify(ModeRequestSchema.parse(value)), 0o600);

/**
 * Ask the session to run under a different permission mode, and wait for its own answer.
 *
 * The published snapshot is the acknowledgement — not the file this writes. A caller told "accepted"
 * because a request file exists would be told a mode is in force that the runtime never applied.
 */
/**
 * Whether a session coming up should be put back into the mode it was last given.
 *
 * A restart dropped it silently before: the request file said `accepted` while the runtime came up
 * in `default`, and the drop went the dangerous way — from a mode that asks before writing to one
 * that asks less. `default` needs no restoring because it is where a runtime starts, and a request
 * from a conversation that no longer exists must never be applied to the one that replaced it.
 */
export function shouldRestoreMode(
  request: RuntimeModeRequest | null,
  generation: string | undefined,
): boolean {
  if (request === null || generation === undefined) return false;
  return (
    request.phase === 'accepted' && request.generation === generation && request.mode !== 'default'
  );
}

export async function requestRuntimeMode(
  m: MachineConfig,
  s: Session,
  mode: PermissionMode,
  signal: AbortSignal,
): Promise<PermissionMode> {
  const read = readManagedRuntimeStatus(m, s);
  if (read.status !== 'live' || !read.snapshot)
    throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
  const generation = read.snapshot.generation;
  if (read.snapshot.permissionMode === mode) return mode;
  await writeRuntimeMode(m, s, { generation, mode, phase: 'queued', reason: null });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const current = readRuntimeMode(m, s);
    if (current?.generation !== generation)
      throw new AppError(
        'IDENTITY_MISMATCH',
        'The conversation changed while setting its mode',
        409,
      );
    if (current.phase === 'rejected')
      throw new AppError('UNSUPPORTED', current.reason ?? 'The runtime refused this mode', 409);
    if (current.phase === 'accepted') {
      const after = readManagedRuntimeStatus(m, s).snapshot?.permissionMode;
      // The runtime's own published mode, not the request: only that proves it took.
      if (after === mode) return mode;
    }
    await Bun.sleep(50);
  }
  throw new AppError('UNAVAILABLE', 'The runtime did not answer the mode request', 503);
}
