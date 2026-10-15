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
}).strict();
export const WakeRequestSchema = SleepTargetSchema.extend({ operationId: z.uuid() }).strict();
export const SleepRecordSchema = SleepTargetSchema.extend({
  operationId: z.uuid(),
  proof: IdleProofSchema,
  phase: z.enum(['requested', 'sleeping', 'waking', 'awake']),
  updatedAt: z.iso.datetime(),
}).strict();
export type SleepRecord = z.infer<typeof SleepRecordSchema>;
export const SleepReceiptSchema = SleepTargetSchema.extend({
  operationId: z.uuid(),
  state: z.enum(['sleeping', 'awake', 'unchanged']),
  release: z.enum(['processReleased', 'handles-only', 'unsupported']),
  nativeId: z.string().nullable(),
  duplicate: z.boolean(),
}).strict();
