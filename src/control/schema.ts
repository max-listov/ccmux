import { z } from "zod";
import { ManagedPeerSchema } from "../config/schema.ts";
import { OwnedCodexTurnSchema } from "../agent/codex/ownedSchema.ts";

export const CONTROL_MAX_BYTES = 512 * 1024;
export const CONTROL_MAX_READERS = 32;
export const ControlTargetSchema = z.object({ target: ManagedPeerSchema }).strict();
export const ControlRowSchema = z.object({
  identity: ManagedPeerSchema,
  runtime: z.enum(["cli", "app-server"]),
  state: z.enum(["working", "idle", "waiting-approval", "waiting-input", "prompt", "stopped", "blocked", "unknown"]),
  availability: z.enum(["live", "stale", "unavailable"]),
  reason: z.string().max(512).nullable(),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  turn: OwnedCodexTurnSchema.nullable(),
  model: z.string().max(512).nullable(),
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
