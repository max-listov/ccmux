import { z } from "zod";
import { OwnedCodexSnapshotSchema } from "../agent/codex/ownedSchema.ts";
import { ModelSelectionSchema, NativeSessionSchema } from "../config/schema.ts";

/** The native projection vocabulary is shared; protocol-specific records remain driver-owned. */
export const ManagedRuntimeSnapshotSchema = OwnedCodexSnapshotSchema.extend({
  provider: z.enum(["codex", "opencode", "custom"]),
  nativeSession: NativeSessionSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  registrationGeneration: z.uuid().optional(),
});
export type ManagedRuntimeSnapshot = z.infer<typeof ManagedRuntimeSnapshotSchema>;
export const ManagedRuntimeReadSchema = z.object({
  protocol: z.literal(1), status: z.enum(["live", "stale", "unavailable"]),
  reason: z.string().nullable(), snapshot: ManagedRuntimeSnapshotSchema.nullable(),
}).strict();
export type ManagedRuntimeRead = z.infer<typeof ManagedRuntimeReadSchema>;
