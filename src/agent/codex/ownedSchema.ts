import { z } from "zod";

export const CODEX_RUNTIME_TTL_MS = 5_000;
export const CODEX_RUNTIME_MAX_BYTES = 128 * 1024;
export const CODEX_RUNTIME_MAX_EVENTS = 128;
export const CODEX_RUNTIME_MAX_NATIVE_ITEMS = 128;

export const OwnedCodexStateSchema = z.enum(["working", "idle", "waiting-approval", "waiting-input", "unknown"]);
export const OwnedCodexTurnSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
  startedAt: z.iso.datetime().nullable(),
}).strict();
export const OwnedCodexEventSchema = z.object({
  sequence: z.number().int().positive(),
  at: z.iso.datetime(),
  kind: z.enum(["state", "turn-start", "turn-end", "unavailable"]),
  state: OwnedCodexStateSchema,
  turn: OwnedCodexTurnSchema.nullable(),
}).strict();
export const OwnedCodexUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).strict();
export const OwnedCodexNativeItemSchema = z.object({
  sequence: z.number().int().positive(), at: z.iso.datetime(),
  kind: z.enum(["user", "assistant", "reasoning", "tool", "approval", "input", "usage", "terminal"]),
  stage: z.enum(["started", "completed", "updated", "requested", "submitted", "resolved"]),
  nativeId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).nullable(),
  requestId: z.string().min(1).max(256).nullable(), status: z.string().max(64).nullable(),
  text: z.string().max(8_192).nullable(), tool: z.string().max(128).nullable(),
  usage: OwnedCodexUsageSchema.nullable(),
}).strict();
const OwnedCodexQuestionSchema = z.object({
  id: z.string().min(1).max(256), header: z.string().max(256), question: z.string().max(2_048),
  isOther: z.boolean(), isSecret: z.boolean(), options: z.array(z.object({
    label: z.string().max(256), description: z.string().max(1_024),
  }).strict()).max(32).nullable(),
  multiple: z.boolean().optional(),
}).strict();
export const OwnedCodexPendingRequestSchema = z.object({
  requestId: z.string().min(1).max(256), rpcId: z.union([z.number(), z.string()]),
  kind: z.enum(["approval", "input"]), approvalKind: z.enum(["command", "file"]).nullable(),
  turnId: z.string().min(1).max(256), itemId: z.string().min(1).max(256),
  reason: z.string().max(2_048).nullable(), decisions: z.array(z.enum(["accept", "acceptForSession", "decline", "cancel"])).max(4),
  questions: z.array(OwnedCodexQuestionSchema).max(3), requestedAt: z.iso.datetime(),
}).strict();
export const OwnedCodexSnapshotSchema = z.object({
  protocol: z.literal(1),
  provider: z.literal("codex"),
  machine: z.string().min(1).max(128),
  session: z.string().min(1).max(256),
  threadId: z.uuid(),
  generation: z.uuid(),
  sequence: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  providerPid: z.number().int().positive(),
  version: z.string().max(64),
  connected: z.boolean(),
  state: OwnedCodexStateSchema,
  reason: z.string().max(256).nullable(),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  turn: OwnedCodexTurnSchema.nullable(),
  events: z.array(OwnedCodexEventSchema).max(CODEX_RUNTIME_MAX_EVENTS),
  nativeSequence: z.number().int().nonnegative().default(0),
  nativeItems: z.array(OwnedCodexNativeItemSchema).max(CODEX_RUNTIME_MAX_NATIVE_ITEMS).default([]),
  pendingRequests: z.array(OwnedCodexPendingRequestSchema).max(16).default([]),
}).strict();
export type OwnedCodexSnapshot = z.infer<typeof OwnedCodexSnapshotSchema>;
export type OwnedCodexTurn = z.infer<typeof OwnedCodexTurnSchema>;
export type OwnedCodexNativeItem = z.infer<typeof OwnedCodexNativeItemSchema>;
export type OwnedCodexPendingRequest = z.infer<typeof OwnedCodexPendingRequestSchema>;
export const OwnedCodexReadSchema = z.object({
  protocol: z.literal(1),
  status: z.enum(["live", "stale", "unavailable"]),
  reason: z.string().nullable(),
  snapshot: OwnedCodexSnapshotSchema.nullable(),
}).strict();
export type OwnedCodexRead = z.infer<typeof OwnedCodexReadSchema>;
