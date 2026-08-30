import { z } from "zod";
import { AgentKindSchema, NativeSessionSchema, LaunchRecipeMetadataSchema, LaunchRecipeReferenceSchema, ManagedPeerSchema, ModelSelectionSchema } from "../config/schema.ts";
import { RuntimeCapabilitiesSchema } from "../runtime/capabilities.ts";
import { OwnedCodexTurnSchema } from "../agent/codex/ownedSchema.ts";
import { OwnedCodexNativeItemSchema, OwnedCodexPendingRequestSchema } from "../agent/codex/ownedSchema.ts";
import { SESSION_NAME_RE } from "../config/schema.ts";

export const CONTROL_MAX_BYTES = 512 * 1024;
export const CONTROL_MAX_READERS = 32;
export const ControlTargetSchema = z.object({ target: ManagedPeerSchema }).strict();
export const ControlRowSchema = z.object({
  identity: ManagedPeerSchema,
  runtime: z.enum(["cli", "app-server", "native"]),
  nativeSession: NativeSessionSchema.optional(),
  driverCapabilities: RuntimeCapabilitiesSchema.optional(),
  state: z.enum(["working", "idle", "waiting-approval", "waiting-input", "prompt", "stopped", "blocked", "unknown"]),
  availability: z.enum(["live", "stale", "unavailable"]),
  reason: z.string().max(512).nullable(),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  turn: OwnedCodexTurnSchema.nullable(),
  model: z.string().max(512).nullable(),
  launchRecipe: LaunchRecipeMetadataSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  capabilities: z.object({ message: z.boolean(), start: z.boolean(), interrupt: z.boolean(), wait: z.boolean() }).strict(),
}).strict();
export type ControlRow = z.infer<typeof ControlRowSchema>;
export const ControlSnapshotSchema = z.object({
  protocol: z.literal(1),
  version: z.string().max(64),
  machine: z.string().max(128),
  generation: z.uuid(),
  sequence: z.number().int().nonnegative(),
  status: z.enum(["live", "stale", "unavailable"]),
  reason: z.string().max(512).nullable(),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  omitted: z.number().int().nonnegative(),
  sessions: z.array(ControlRowSchema).max(256),
}).strict();
export type ControlSnapshot = z.infer<typeof ControlSnapshotSchema>;
export const ControlMessageSchema = ControlTargetSchema.extend({
  messageId: z.uuid(),
  body: z.string().trim().min(1).max(16_384),
  defer: z.boolean().default(false),
  notBefore: z.iso.datetime().nullable().default(null),
  task: z.string().max(256).nullable().default(null),
}).strict();
export type ControlMessage = z.infer<typeof ControlMessageSchema>;
export const ControlMessageReceiptSchema = z.object({
  messageId: z.uuid(), accepted: z.literal(true), duplicate: z.boolean(),
}).strict();
export const ControlInterruptSchema = ControlTargetSchema.extend({ turnId: z.string().min(1).max(256) }).strict();
export const ControlActionReceiptSchema = z.object({ target: ManagedPeerSchema, accepted: z.literal(true) }).strict();
export const ControlCreateSchema = z.object({
  runtime: AgentKindSchema.optional(),
  requestId: z.uuid(), name: z.string().min(1).max(256).regex(SESSION_NAME_RE),
  workspace: z.string().startsWith("/").max(4_096), flags: z.array(z.string().max(4_096)).max(32).default([]),
  launchRecipe: LaunchRecipeReferenceSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
}).strict();
export type ControlCreate = z.input<typeof ControlCreateSchema>;
export const ControlCreateReceiptSchema = z.object({
  requestId: z.uuid(), target: ManagedPeerSchema, workspace: z.string().startsWith("/").max(4_096),
  duplicate: z.boolean(), launchRecipe: LaunchRecipeMetadataSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  nativeSession: NativeSessionSchema.optional(),
  driverCapabilities: RuntimeCapabilitiesSchema.optional(),
}).strict();
export type ControlCreateReceipt = z.infer<typeof ControlCreateReceiptSchema>;
export const ControlArchiveReceiptSchema = z.object({
  target: ManagedPeerSchema, archived: z.literal(true), duplicate: z.boolean(), stopped: z.boolean(),
}).strict();
export type ControlArchiveReceipt = z.infer<typeof ControlArchiveReceiptSchema>;
export const ControlNativeCursorSchema = z.object({ generation: z.uuid(), sequence: z.number().int().nonnegative() }).strict();
export const ControlNativeReadSchema = ControlTargetSchema.extend({ cursor: ControlNativeCursorSchema.nullable().default(null) }).strict();
export const ControlNativeSnapshotSchema = z.object({
  target: ManagedPeerSchema, generation: z.uuid(), sequence: z.number().int().nonnegative(),
  reset: z.enum(["initial", "generation", "gap"]).nullable(), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  items: z.array(OwnedCodexNativeItemSchema).max(128), pending: z.array(OwnedCodexPendingRequestSchema.omit({ rpcId: true })).max(16),
  launchRecipe: LaunchRecipeMetadataSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  nativeSession: NativeSessionSchema.optional(),
  driverCapabilities: RuntimeCapabilitiesSchema.optional(),
}).strict();
export type ControlNativeSnapshot = z.infer<typeof ControlNativeSnapshotSchema>;
export const ControlNativeResponseSchema = ControlTargetSchema.extend({
  operationId: z.uuid(), generation: z.uuid(), requestId: z.string().min(1).max(256),
  kind: z.enum(["approval", "input"]), decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).nullable().default(null),
  answers: z.record(z.string().min(1).max(256), z.array(z.string().max(4_096)).min(1).max(32)).nullable().default(null),
}).strict();
export type ControlNativeResponse = z.input<typeof ControlNativeResponseSchema>;
export const ControlNativeResponseReceiptSchema = z.object({
  operationId: z.uuid(), requestId: z.string(), outcome: z.enum(["submitted", "uncertain"]),
}).strict();
export type ControlNativeResponseReceipt = z.infer<typeof ControlNativeResponseReceiptSchema>;
export const CONTROL_MODELS_MAX_PAGE = 64;
export const ControlModelsReadSchema = z.object({
  runtime: AgentKindSchema.optional(),
  target: ManagedPeerSchema.optional(),
  launchRecipe: LaunchRecipeReferenceSchema.optional(),
  cursor: z.string().min(1).max(4_096).nullable().default(null),
  limit: z.number().int().min(1).max(CONTROL_MODELS_MAX_PAGE).default(CONTROL_MODELS_MAX_PAGE),
  includeHidden: z.boolean().default(false),
}).strict().refine((input) => input.target === undefined || input.launchRecipe === undefined,
  "Choose a host recipe or an exact managed runtime, not both");
export type ControlModelsRead = z.input<typeof ControlModelsReadSchema>;
export const ControlModelSchema = z.object({
  provider: z.string().min(1).max(128).optional(),
  id: z.string().min(1).max(256),
  model: z.string().min(1).max(256).optional(),
  displayName: z.string().min(1).max(256),
  description: z.string().max(2_048),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.string().min(1).max(64)).max(16),
  serviceTiers: z.array(z.object({
    id: z.string().min(1).max(64), name: z.string().min(1).max(256), description: z.string().max(1_024),
  }).strict()).max(16),
  supportedReasoningEfforts: z.array(z.object({
    reasoningEffort: z.string().min(1).max(64), description: z.string().max(1_024),
  }).strict()).max(32).optional(),
  defaultReasoningEffort: z.string().min(1).max(64).optional(),
}).strict();
export type ControlModel = z.infer<typeof ControlModelSchema>;
export const ControlModelCatalogSchema = z.object({
  target: ManagedPeerSchema.optional(),
  source: z.object({
    kind: z.enum(["host", "session"]), machine: z.string().min(1),
    provider: z.string().min(1).max(128).nullable(), runtime: AgentKindSchema.optional(), launchRecipe: LaunchRecipeMetadataSchema.optional(),
  }).strict(),
  data: z.array(ControlModelSchema).max(CONTROL_MODELS_MAX_PAGE),
  nextCursor: z.string().max(4_096).nullable(),
}).strict();
export type ControlModelCatalog = z.infer<typeof ControlModelCatalogSchema>;
export const ControlWaitSchema = ControlTargetSchema.extend({ timeoutMs: z.number().int().min(1).max(60_000).default(30_000) }).strict();
export const ControlWaitResultSchema = z.object({
  target: ManagedPeerSchema, outcome: z.enum(["idle", "completed", "interrupted", "failed", "timeout", "unavailable"]),
  state: ControlRowSchema.nullable(),
}).strict();

/** A retained or delayed snapshot cannot extend the producer's observation lease. */
export function currentControlSnapshot(snapshot: ControlSnapshot, now = Date.now()): ControlSnapshot {
  const current = structuredClone(snapshot);
  if (Date.parse(current.observedAt) > now) {
    current.status = "unavailable";
    current.reason = "clock-skew";
  }
  if (current.status === "live" && Date.parse(current.expiresAt) <= now) {
    current.status = "stale";
    current.reason = "observation-expired";
  }
  for (const row of current.sessions) {
    if (row.availability === "live" && (Date.parse(row.expiresAt) <= now || Date.parse(row.observedAt) > now || current.status !== "live")) {
      row.availability = current.status === "unavailable" ? "unavailable" : "stale";
      row.state = "unknown";
      row.reason = current.reason ?? "observation-expired";
    }
  }
  return current;
}
