import { z } from 'zod';
import { ManagedPeerSchema } from '../../chat/identitySchema.ts';

const ProcessIdentitySchema = z
  .object({ pid: z.number().int().positive(), startTime: z.string() })
  .strict();
export const SleepTargetSchema = z
  .object({ target: ManagedPeerSchema, registrationGeneration: z.uuid() })
  .strict();
export const IdleProofSchema = SleepTargetSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.uuid().nullable(),
  observedAt: z.iso.datetime(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  run: z.enum(['idle', 'active', 'unknown']),
  queue: z.number().int().nonnegative().nullable(),
  approvals: z.number().int().nonnegative().nullable(),
  children: z.number().int().nonnegative().nullable(),
  background: z.number().int().nonnegative().nullable(),
  processes: z.array(ProcessIdentitySchema).max(256),
}).strict();
export type IdleProof = z.infer<typeof IdleProofSchema>;
export const SleepRequestSchema = SleepTargetSchema.extend({
  operationId: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  /** Bypass `pinned` and `minAwakePerProfile` policy checks while keeping idle/safety guards. */
  forcePolicy: z.boolean().optional(),
}).strict();
export const WakeRequestSchema = SleepTargetSchema.extend({ operationId: z.uuid() }).strict();
export const PinRequestSchema = z
  .object({
    target: ManagedPeerSchema,
    pinned: z.boolean(),
  })
  .strict();
export const PinReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    pinned: z.boolean(),
  })
  .strict();
export const SleepRecordSchema = SleepTargetSchema.extend({
  operationId: z.uuid(),
  proof: IdleProofSchema,
  phase: z.enum(['requested', 'sleeping', 'waking', 'awake']),
  forcePolicy: z.boolean().optional(),
  updatedAt: z.iso.datetime(),
}).strict();
export type SleepRecord = z.infer<typeof SleepRecordSchema>;
export const SleepReceiptSchema = SleepTargetSchema.extend({
  operationId: z.uuid(),
  state: z.enum(['sleeping', 'awake', 'unchanged']),
  release: z.enum(['processReleased', 'unsupported']),
  nativeId: z.string().nullable(),
  duplicate: z.boolean(),
}).strict();

/** `session.sleep-idle`: put to sleep every session idle at least this long, or say which would be. */
export const SleepIdleRequestSchema = z
  .object({
    idleAfterMinutes: z.number().int().min(1).max(43_200),
    dryRun: z.boolean().default(false),
  })
  .strict();

/**
 * One session's answer in a `session.sleep-idle` pass. `skipped` is policy or state that keeps it
 * awake by design (pinned, busy, the profile's last awake session); `refused` is a failure;
 * `not-attempted` is a candidate the pass did not reach within its budget. `code` is from the refusal
 * table whenever there is one.
 */
export const SleepIdleReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    outcome: z.enum(['slept', 'would-sleep', 'skipped', 'refused', 'not-attempted']),
    code: z.string().min(1).max(64).nullable(),
    reason: z.string().max(1024).nullable(),
  })
  .strict();
export type SleepIdleReceipt = z.infer<typeof SleepIdleReceiptSchema>;

export const SleepIdleResultSchema = z
  .object({
    machine: z.string().min(1).max(128),
    dryRun: z.boolean(),
    receipts: z.array(SleepIdleReceiptSchema).max(256),
  })
  .strict();
