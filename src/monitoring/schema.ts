import { z } from 'zod';
import { AgentKindSchema } from '../chat/identitySchema.ts';

export const STATUS_MAX_ITEMS = 256;
export const STATUS_MAX_BYTES = 512 * 1024;
export const STATUS_MAX_AGE_MS = 10_000;
export const STATUS_INTERVAL_MS = 2_000;

export const MonitoringStepSchema = z.object({
  kind: z.string().min(1).max(64),
  role: z.string().min(1).max(64),
  toolName: z.string().min(1).max(256).nullable(),
  at: z.string().min(1).max(64).nullable(),
});
export type MonitoringStep = z.infer<typeof MonitoringStepSchema>;

/**
 * One managed session row in protocol-1 `monitoring-status.json`.
 *
 * Wire schemas tolerate additive fields from a newer producer (no `.strict()`): consumers bundle
 * `ccmux/monitoring-reader` at their own release cadence, and rejecting unknown keys turns any
 * additive producer field into a fleet-wide `unavailable/invalid` outage until every consumer
 * rebuilds. Every declared identity, enum, timestamp and byte/item bound remains strictly checked.
 */
export const MonitoringRowSchema = z.object({
  plane: z.literal('managed'),
  name: z.string().min(1).max(256),
  agent: AgentKindSchema,
  uuid: z.uuid(),
  rc: z.string().max(512),
  address: z.string().max(512),
  dir: z.string().max(8192),
  archived: z.boolean(),
  running: z.boolean(),
  state: z.enum(['working', 'idle', 'prompt', 'stopped', 'blocked', 'unknown']),
  model: z.string().max(512).nullable(),
  contextPercent: z.number().min(0).max(100).nullable(),
  /**
   * How many times a minute this session's status line is being rendered.
   *
   * The statusLine command runs per session on every transcript event, which makes it the most
   * frequent thing this tool causes a machine to do, and until it was counted its cost was argued
   * from a `ps` sample — an instrument that cannot see a process shorter than its own interval.
   * Null when the session has not reported a window yet, which is not the same as zero.
   */
  statusLineRendersPerMinute: z.number().nonnegative().nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  /** When the running session process was started/restarted (ISO instant), or null when stopped or unknown. */
  startedAt: z.iso.datetime().nullable().optional(),
  /** When the conversation last had a real message/step (ISO instant), or null if none yet; never bare file mtime. */
  lastActivityAt: z.iso.datetime().nullable(),
  turnStartedAt: z.iso.datetime().nullable(),
  /** Structural shape of the last transcript entry (never message text), or null. */
  step: MonitoringStepSchema.nullable().optional(),
  /** Title of the blocking prompt this session is sitting at, or null. */
  atPrompt: z.string().min(1).max(256).nullable().optional(),
  /** Fleet address of the session this one is waiting for, or null. */
  waitingFor: z.string().min(1).max(256).nullable().optional(),
  /** True when the session is in the durable sleeping state (running: false, state: 'stopped'). */
  sleeping: z.boolean().optional(),
  /** True when the session is pinned awake against auto-sleep and unforced manual sleep. */
  pinned: z.boolean().optional(),
  /** Measured process-tree memory in bytes (phys_footprint on macOS, PSS+SwapPss on Linux); 0 when stopped/sleeping, null when unavailable. */
  memoryBytes: z.number().int().nonnegative().nullable().optional(),
  /** Current registration generation UUID when assigned, or null. */
  registrationGeneration: z.uuid().nullable().optional(),
  observedAt: z.iso.datetime(),
});
export type MonitoringRow = z.infer<typeof MonitoringRowSchema>;

export const MonitoringSnapshotSchema = z.object({
  protocol: z.literal(1),
  version: z.string().min(1).max(64),
  generation: z.uuid(),
  sequence: z.number().int().positive(),
  pid: z.number().int().positive(),
  rcPrefix: z.string().min(1).max(128),
  scope: z.literal('managed'),
  observedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  refreshDurationMs: z.number().nonnegative(),
  maxAgeMs: z.literal(STATUS_MAX_AGE_MS),
  limits: z
    .object({ items: z.literal(STATUS_MAX_ITEMS), bytes: z.literal(STATUS_MAX_BYTES) })
    .strict(),
  omitted: z.number().int().nonnegative(),
  sessions: z.array(MonitoringRowSchema).max(STATUS_MAX_ITEMS),
});
export type MonitoringSnapshot = z.infer<typeof MonitoringSnapshotSchema>;

export const MonitoringReadSchema = z
  .object({
    protocol: z.literal(1),
    status: z.enum(['live', 'stale', 'unavailable']),
    reason: z
      .enum([
        'missing',
        'invalid',
        'oversized',
        'producer-stopped',
        'expired',
        'clock-skew',
        'read-failed',
        'unauthorized',
        'config-changed',
        'cancelled',
        'deadline',
        'busy',
      ])
      .nullable(),
    snapshot: MonitoringSnapshotSchema.nullable(),
  })
  .strict();
export type MonitoringRead = z.infer<typeof MonitoringReadSchema>;
