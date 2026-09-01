import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { defineMailbox } from './mailbox.ts';
import { type PermissionMode, PermissionModeSchema } from './projectionSchema.ts';
import { readManagedRuntimeStatus } from './status.ts';

/**
 * The requested permission mode, durable between the caller and the session that owns the runtime.
 *
 * A setting, not a turn: it carries a generation so a request written for one conversation can
 * never be applied to the conversation that replaced it.
 */
const ModeRequestFields = z
  .object({
    operationId: z.uuid(),
    generation: z.uuid(),
    mode: PermissionModeSchema,
    phase: z.enum(['queued', 'complete', 'failed']),
    reason: z.string().max(256).nullable().default(null),
  })
  .strict();

/**
 * A record is read in the shape an earlier build may have written it, and upgraded on the way in.
 *
 * The mode is the one durable request whose loss is dangerous rather than merely annoying: a
 * session that cannot read its own record comes up in `default`, which asks less before writing
 * than whatever it was put into. Rejecting the older shape would therefore have downgraded every
 * session that was in `plan` or `acceptEdits` at the moment of an upgrade — the exact drop
 * `shouldRestoreMode` exists to prevent, performed by the code that prevents it.
 *
 * A bounded migration with an end: it can go once no session can still be holding a record written
 * before the operation id existed, which is one restart of every managed session.
 */
const ModeRequestSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || 'operationId' in value) return value;
  const legacy = value as { phase?: unknown; generation?: unknown };
  return {
    ...legacy,
    // Derived from the conversation it was written for, so the upgraded record keeps the identity
    // it had. A fresh id would make the session's own record look like somebody else's request.
    operationId: legacy.generation,
    phase:
      legacy.phase === 'accepted'
        ? 'complete'
        : legacy.phase === 'rejected'
          ? 'failed'
          : legacy.phase,
  };
}, ModeRequestFields);
export type RuntimeModeRequest = z.infer<typeof ModeRequestSchema>;

/**
 * The shortest deadline after an interrupt: nothing is fetched and nothing is restored — the
 * runtime either takes the setting between turns or it does not, and a caller who asked for a
 * safer mode should not sit waiting for a minute to find out.
 */
const mailbox = defineMailbox<RuntimeModeRequest, PermissionMode>({
  file: 'permission-mode',
  schema: ModeRequestSchema,
  identity: (receipt) => receipt.operationId,
  pollMs: 50,
  deadlineMs: 10_000,
  settle: (receipt, snapshot) => {
    if (receipt.phase === 'failed')
      throw new AppError('UNSUPPORTED', receipt.reason ?? 'The runtime refused this mode', 409);
    if (receipt.phase !== 'complete') return undefined;
    // The runtime's own published mode, not the request: only that proves it took.
    return snapshot()?.permissionMode === receipt.mode ? receipt.mode : undefined;
  },
  mismatch: () =>
    new AppError('IDENTITY_MISMATCH', 'The conversation changed while setting its mode', 409),
});

export const readRuntimeMode = (m: MachineConfig, s: Session) => mailbox.read(m, s);
export const writeRuntimeMode = (m: MachineConfig, s: Session, value: RuntimeModeRequest) =>
  mailbox.write(m, s, value);

/**
 * Whether a session coming up should be put back into the mode it was last given.
 *
 * A restart dropped it silently before: the request file said the mode had been applied while the
 * runtime came up in `default`, and the drop went the dangerous way — from a mode that asks before
 * writing to one that asks less. `default` needs no restoring because it is where a runtime starts,
 * and a request from a conversation that no longer exists must never be applied to the one that
 * replaced it.
 */
export function shouldRestoreMode(
  request: RuntimeModeRequest | null,
  generation: string | undefined,
): boolean {
  if (request === null || generation === undefined) return false;
  return (
    request.phase === 'complete' && request.generation === generation && request.mode !== 'default'
  );
}

export async function requestRuntimeMode(
  m: MachineConfig,
  s: Session,
  input: { operationId: string; mode: PermissionMode },
  signal: AbortSignal,
): Promise<PermissionMode> {
  // Already in force: answered without asking. Not merely a saving — a mode is applied between
  // turns, so queueing a request for the mode a session is already in would make a caller wait out
  // the deadline of a long turn to be told what was true before it asked.
  const live = readManagedRuntimeStatus(m, s);
  if (live.status === 'live' && live.snapshot?.permissionMode === input.mode) return input.mode;
  return mailbox.request(
    m,
    s,
    input.operationId,
    (generation) => ({
      operationId: input.operationId,
      generation,
      mode: input.mode,
      phase: 'queued',
      reason: null,
    }),
    signal,
  );
}
