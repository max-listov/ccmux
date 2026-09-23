import { z } from 'zod';
import { ControlCommandSchema } from '../../agent/claude/native/commandSchema.ts';
import { ManagedPeerSchema } from '../../chat/identitySchema.ts';
import { NativeMcpServerSchema, PermissionModeSchema } from '../../runtime/projectionSchema.ts';
import { RewindResultSchema } from '../../runtime/rewindSchema.ts';
import { ControlRowSchema, type ControlSnapshot, ControlTargetSchema } from './core.ts';

export const ControlCommandsReadSchema = ControlTargetSchema.strict();
export const ControlCommandCatalogSchema = z
  .object({
    target: ManagedPeerSchema,
    /** What the runtime named, verbatim: this project does not add commands of its own. */
    data: z.array(ControlCommandSchema).max(512),
  })
  .strict();
export const ControlRunCommandSchema = ControlTargetSchema.extend({
  /** The command's name, with or without its leading slash; an alias the runtime declared resolves. */
  command: z.string().min(1).max(128),
  /** Everything after the command, exactly as a person would have typed it. */
  args: z.string().max(4_096).optional(),
  /**
   * Idempotency, the same way a message carries it: a retried run must not become a second turn.
   */
  operationId: z.uuid(),
}).strict();
export const ControlRunCommandReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    accepted: z.literal(true),
    /** The turn this command became, so a caller can follow it in the session's own stream. */
    turnId: z.string().min(1).max(256),
    /** The exact text delivered, so a caller never has to guess how its arguments were framed. */
    text: z.string().min(1).max(4_224),
  })
  .strict();
export const ControlPermissionModeSchema = ControlTargetSchema.extend({
  /**
   * The caller's name for this request, so a retry is the same request rather than a second one.
   *
   * Carried here for the same reason as on rewind and MCP control: a mode change that was applied
   * but whose answer was lost must replay to the answer it already got, not start again against a
   * session that has since moved on.
   */
  operationId: z.uuid(),
  mode: PermissionModeSchema,
}).strict();
export const ControlPermissionModeReceiptSchema = z
  .object({ target: ManagedPeerSchema, mode: PermissionModeSchema })
  .strict();

/**
 * Reading and replacing the permission mode of a live session.
 *
 * The runtime owns this value — we ask it and we ask it to change, and there is no register of our
 * own beside it. A revisioned copy was written and removed before it shipped: it would have
 * versioned our own record of intent while the thing a caller must not do blindly is overwrite a
 * mode changed somewhere else, which only a comparison against the OBSERVED value catches.
 */
export const ControlPermissionReadSchema = ControlTargetSchema.extend({
  registrationGeneration: z.uuid(),
}).strict();
export const ControlPermissionResultSchema = z
  .object({
    target: ManagedPeerSchema,
    /** What the runtime reports, and when it was seen. Null while it is not live: not knowing is
     * a different answer from running without a mode. */
    native: z
      .object({ mode: PermissionModeSchema, observedAt: z.string().max(64) })
      .strict()
      .nullable(),
    /** What this runtime accepts, reported rather than assumed: the sets differ per runtime. */
    supported: z.array(PermissionModeSchema).max(16),
  })
  .strict();
export const ControlPermissionUpdateSchema = ControlTargetSchema.extend({
  registrationGeneration: z.uuid(),
  operationId: z.uuid(),
  /**
   * The mode the caller believes this session is in, checked against what the runtime reports.
   *
   * Not a revision, and deliberately: a counter of our own would version OUR record of intent and
   * would not notice the case a caller actually needs protection from — the mode changed somewhere
   * other than through us. Comparing against the observed value is the check that catches it, and
   * it is founded on something we genuinely know rather than on a number we made up.
   */
  expectedMode: PermissionModeSchema,
  mode: PermissionModeSchema,
}).strict();

export const ControlRewindSchema = ControlTargetSchema.extend({
  /** The user message to put the files back to, as the runtime's transcript identifies it. */
  messageId: z.uuid(),
  /** Preview only. The same code answers both, so what is previewed is what would happen. */
  dryRun: z.boolean().default(false),
  operationId: z.uuid(),
}).strict();
export const ControlRewindReceiptSchema = z
  .object({ target: ManagedPeerSchema, dryRun: z.boolean(), result: RewindResultSchema })
  .strict();

export const ControlMcpReadSchema = ControlTargetSchema.strict();
export const ControlMcpListSchema = z
  .object({ target: ManagedPeerSchema, data: z.array(NativeMcpServerSchema).max(64) })
  .strict();
export const ControlMcpControlSchema = ControlTargetSchema.extend({
  server: z.string().min(1).max(128),
  action: z.enum(['enable', 'disable', 'reconnect']),
  operationId: z.uuid(),
}).strict();
export const ControlMcpControlReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    server: z.string().min(1).max(128),
    /** What the server looks like AFTER the operation, not that the request was taken. */
    status: z.string().min(1).max(64),
  })
  .strict();

export const ControlWaitSchema = ControlTargetSchema.extend({
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
}).strict();
export const ControlWaitResultSchema = z
  .object({
    target: ManagedPeerSchema,
    outcome: z.enum(['idle', 'completed', 'interrupted', 'failed', 'timeout', 'unavailable']),
    state: ControlRowSchema.nullable(),
  })
  .strict();

/** A retained or delayed snapshot cannot extend the producer's observation lease. */
export function currentControlSnapshot(
  snapshot: ControlSnapshot,
  now = Date.now(),
): ControlSnapshot {
  const current = structuredClone(snapshot);
  if (Date.parse(current.observedAt) > now) {
    current.status = 'unavailable';
    current.reason = 'clock-skew';
  }
  if (current.status === 'live' && Date.parse(current.expiresAt) <= now) {
    current.status = 'stale';
    current.reason = 'observation-expired';
  }
  for (const row of current.sessions) {
    if (
      row.availability === 'live' &&
      (Date.parse(row.expiresAt) <= now ||
        Date.parse(row.observedAt) > now ||
        current.status !== 'live')
    ) {
      row.availability = current.status === 'unavailable' ? 'unavailable' : 'stale';
      row.state = 'unknown';
      row.reason = current.reason ?? 'observation-expired';
      if (row.applicationPolicy !== undefined) {
        row.applicationPolicy.state = 'unavailable';
        // Expiry is a reason too, and it is the one a reader is least likely to guess: the policy
        // was proved once and the proof aged out, which is not the same repair as a policy that
        // never applied.
        row.applicationPolicy.reason = row.reason;
      }
      delete row.nativeProfile;
    }
  }
  return current;
}
