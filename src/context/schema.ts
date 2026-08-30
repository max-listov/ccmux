import { z } from "zod";
import { AttachmentReferencesSchema } from "../attachments/reference.ts";
import { ManagedPeerSchema } from "../config/schema.ts";

export const HISTORY_LIMITS = { entries: 64, textBytes: 128 * 1024, itemBytes: 16 * 1024, fileBytes: 384 * 1024, deadlineMs: 5_000 };
const Id = z.string().min(1).max(256);
export const NativeHistoryQuerySchema = z.object({ limit: z.number().int().min(1).max(HISTORY_LIMITS.entries).default(32),
  cursor: z.string().min(1).max(8_192).optional() }).strict();
export const NativeHistoryEntrySchema = z.object({ turnId: Id, itemId: Id,
  kind: z.enum(["user", "assistant", "reasoning-summary", "tool", "compaction", "other"]),
  text: z.string().nullable(), omittedBytes: z.number().int().nonnegative(),
  images: AttachmentReferencesSchema, omittedImages: z.number().int().nonnegative(),
  status: z.enum(["inProgress", "completed", "failed", "unknown"]),
}).strict();
export const NativeHistoryPageSchema = z.object({ runtime: z.enum(["codex", "opencode"]), nativeId: Id,
  revision: z.number().int().nonnegative(), entries: z.array(NativeHistoryEntrySchema).max(HISTORY_LIMITS.entries),
  nextCursor: z.string().max(8_192).nullable(), completeness: z.enum(["complete", "more", "unknown"]),
  omittedItems: z.number().int().nonnegative(), omittedBytes: z.number().int().nonnegative(),
}).strict();
export const CompactRequestSchema = z.object({ operationId: z.uuid(), generation: z.uuid() }).strict();
export const NativeForkRequestSchema = z.object({ target: ManagedPeerSchema, registrationGeneration: z.uuid(), generation: z.uuid(),
  requestId: z.uuid(), name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/) }).strict();
export const ContextOperationSchema = z.object({ operationId: z.uuid(), generation: z.uuid(),
  state: z.enum(["queued", "dispatching", "running", "completed", "uncertain", "rejected"]),
  revision: z.number().int().nonnegative(), markerBefore: Id.nullable(), createdAt: z.number(), updatedAt: z.number(),
}).strict();
export type NativeHistoryQuery = z.infer<typeof NativeHistoryQuerySchema>;
export type NativeHistoryPage = z.infer<typeof NativeHistoryPageSchema>;
export type NativeHistoryEntry = z.infer<typeof NativeHistoryEntrySchema>;
export type CompactRequest = z.infer<typeof CompactRequestSchema>;
export type NativeForkRequest = z.infer<typeof NativeForkRequestSchema>;
export type ContextOperation = z.infer<typeof ContextOperationSchema>;
