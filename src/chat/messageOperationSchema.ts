import { z } from 'zod';
import { ManagedPeerSchema } from '../config/schema.ts';

const NativeMessageSessionSchema = z
  .object({ runtime: z.enum(['codex', 'opencode', 'custom']), id: z.string().min(1).max(256) })
  .strict();

export const MESSAGE_OPERATION_LIMITS = {
  records: 256,
  bytes: 512 * 1024,
  terminalTtlMs: 7 * 24 * 60 * 60 * 1000,
};
export const MessageOperationReadSchema = z
  .object({
    target: ManagedPeerSchema,
    registrationGeneration: z.uuid(),
    messageId: z.uuid(),
  })
  .strict();
export const MessageOperationStateSchema = z.enum([
  'queued',
  'uncertain',
  'admitted',
  'completed',
  'interrupted',
  'failed',
]);
export const MessageOperationEvidenceSchema = z
  .object({
    state: MessageOperationStateSchema,
    nativeSession: NativeMessageSessionSchema,
    turnId: z.string().min(1).max(256).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.state === 'queued' || value.state === 'uncertain') === (value.turnId === null),
    'Native binding does not match admission state',
  )
  .refine(
    (value) =>
      ['completed', 'interrupted', 'failed'].includes(value.state) === (value.expiresAt !== null),
    'Retention deadline does not match terminal state',
  );
export const MessageOperationResultSchema = MessageOperationReadSchema.extend({
  outcome: z.enum(['available', 'unavailable', 'expired']),
  evidence: MessageOperationEvidenceSchema.nullable(),
})
  .strict()
  .refine(
    (value) => (value.outcome === 'available') === (value.evidence !== null),
    'Unavailable evidence must not carry a binding',
  );
export const MessageOperationRecordSchema = z
  .object({
    messageId: z.uuid(),
    principal: z.string().regex(/^[0-9a-f]{64}$/),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    phase: z.enum(['preparing', ...MessageOperationStateSchema.options]),
    turnId: z.string().min(1).max(256).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      ['preparing', 'queued', 'uncertain'].includes(value.phase) === (value.turnId === null),
    'Native binding does not match receipt phase',
  )
  .refine(
    (value) =>
      ['completed', 'interrupted', 'failed'].includes(value.phase) === (value.expiresAt !== null),
    'Receipt retention deadline does not match terminal phase',
  );
export const MessageOperationJournalSchema = z
  .object({
    registrationGeneration: z.uuid(),
    nativeSession: NativeMessageSessionSchema,
    records: z.array(MessageOperationRecordSchema).max(MESSAGE_OPERATION_LIMITS.records),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.messageId)).size === value.records.length,
    'Duplicate message receipt',
  )
  .refine((value) => {
    const turns = value.records.flatMap((record) =>
      record.turnId === null ? [] : [record.turnId],
    );
    return new Set(turns).size === turns.length;
  }, 'Duplicate native turn binding');
export type MessageOperationRecord = z.output<typeof MessageOperationRecordSchema>;
export type MessageOperationJournal = z.output<typeof MessageOperationJournalSchema>;
export type MessageOperationRead = z.output<typeof MessageOperationReadSchema>;
export type MessageOperationResult = z.output<typeof MessageOperationResultSchema>;
export type MessageOperationEvidence = z.output<typeof MessageOperationEvidenceSchema>;
