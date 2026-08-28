import { z } from "zod";

export const CODEX_RUNTIME_TTL_MS = 5_000;
export const CODEX_RUNTIME_MAX_BYTES = 128 * 1024;
export const CODEX_RUNTIME_MAX_EVENTS = 128;

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
}).strict();
export type OwnedCodexSnapshot = z.infer<typeof OwnedCodexSnapshotSchema>;
export type OwnedCodexTurn = z.infer<typeof OwnedCodexTurnSchema>;
export const OwnedCodexReadSchema = z.object({
  protocol: z.literal(1),
  status: z.enum(["live", "stale", "unavailable"]),
  reason: z.string().nullable(),
  snapshot: OwnedCodexSnapshotSchema.nullable(),
}).strict();
export type OwnedCodexRead = z.infer<typeof OwnedCodexReadSchema>;
