import { z } from "zod";
import { AgentKindSchema } from "../config/schema.ts";

export const STATUS_MAX_ITEMS = 256;
export const STATUS_MAX_BYTES = 512 * 1024;
export const STATUS_MAX_AGE_MS = 10_000;
export const STATUS_INTERVAL_MS = 2_000;

export const MonitoringRowSchema = z.object({
  plane: z.literal("managed"),
  name: z.string().min(1).max(256),
  agent: AgentKindSchema,
  uuid: z.uuid(),
  rc: z.string().max(512),
  address: z.string().max(512),
  dir: z.string().max(8192),
  archived: z.boolean(),
  running: z.boolean(),
  state: z.enum(["working", "idle", "prompt", "stopped", "blocked", "unknown"]),
  model: z.string().max(512).nullable(),
  contextPercent: z.number().min(0).max(100).nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
  turnStartedAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
}).strict();
export type MonitoringRow = z.infer<typeof MonitoringRowSchema>;

export const MonitoringSnapshotSchema = z.object({
  protocol: z.literal(1),
  version: z.string().min(1).max(64),
  generation: z.uuid(),
  sequence: z.number().int().positive(),
  pid: z.number().int().positive(),
  rcPrefix: z.string().min(1).max(128),
  scope: z.literal("managed"),
  observedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  refreshDurationMs: z.number().nonnegative(),
  maxAgeMs: z.literal(STATUS_MAX_AGE_MS),
  limits: z.object({ items: z.literal(STATUS_MAX_ITEMS), bytes: z.literal(STATUS_MAX_BYTES) }).strict(),
  omitted: z.number().int().nonnegative(),
  sessions: z.array(MonitoringRowSchema).max(STATUS_MAX_ITEMS),
}).strict();
export type MonitoringSnapshot = z.infer<typeof MonitoringSnapshotSchema>;

export const MonitoringReadSchema = z.object({
  protocol: z.literal(1),
  status: z.enum(["live", "stale", "unavailable"]),
  reason: z.enum(["missing", "invalid", "oversized", "producer-stopped", "expired", "clock-skew", "read-failed", "unauthorized", "config-changed", "cancelled", "deadline", "busy"]).nullable(),
  snapshot: MonitoringSnapshotSchema.nullable(),
}).strict();
export type MonitoringRead = z.infer<typeof MonitoringReadSchema>;
