import { z } from 'zod';
import { NativeSessionSchema } from '../config/schema.ts';
import { NativeAccountSchema, NativeSnapshotSchema } from './projectionSchema.ts';

/** The native projection vocabulary is shared; protocol-specific records remain driver-owned. */
export const ManagedRuntimeSnapshotSchema = NativeSnapshotSchema.extend({
  nativeSession: NativeSessionSchema.optional(),
  registrationGeneration: z.uuid().optional(),
});
export type ManagedRuntimeSnapshot = z.infer<typeof ManagedRuntimeSnapshotSchema>;
export const ManagedRuntimeReadSchema = z
  .object({
    protocol: z.literal(1),
    status: z.enum(['live', 'stale', 'unavailable']),
    reason: z.string().nullable(),
    snapshot: ManagedRuntimeSnapshotSchema.nullable(),
    /**
     * What stays true after the runtime stops, kept when the live snapshot is dropped.
     *
     * A stale projection must not answer questions about state — that is why the snapshot goes to
     * null the moment its lease expires. Identity is a different kind of fact: which account a
     * session runs on does not stop being true because the process died, and dropping it with
     * everything else made the account VANISH from `accounts` while the person was still signed in.
     * A consumer drawing plan usage then loses the row entirely, which reads as "no plan" rather
     * than "not running".
     */
    retained: z
      .object({ account: NativeAccountSchema.nullable() })
      .strict()
      .nullable()
      // Optional rather than defaulted: every existing construction of this read is about live
      // state and says nothing about identity, and making them all restate `retained: null` would
      // be churn that hides the two places where the value actually matters.
      .optional(),
  })
  .strict();
export type ManagedRuntimeRead = z.infer<typeof ManagedRuntimeReadSchema>;
