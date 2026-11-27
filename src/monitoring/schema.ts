import { z } from 'zod';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import { SessionBoundarySchema } from '../session/boundary.ts';

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
 * One managed session row in protocol-1 `monitoring-status.json`, as the daemon writes it.
 *
 * The snapshot is data two versions read on a live node: the installed daemon writes it, and a
 * consumer reads it with the reader it bundled at its own release (ADR
 * `docs/decisions/2026-11-27-monitoring-snapshot-read-tolerance.md`). So there are two schemas. This
 * one is the producer's: every field it always writes is required, and the producer checks its own
 * rows against it. `MonitoringRowReadSchema` below is the consumer's, tolerant where a newer or
 * older producer may differ and strict everywhere else.
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
  startedAt: z.iso.datetime().nullable(),
  /** When the conversation last had a real message/step (ISO instant), or null if none yet; never bare file mtime. */
  lastActivityAt: z.iso.datetime().nullable(),
  turnStartedAt: z.iso.datetime().nullable(),
  /** Structural shape of the last transcript entry (never message text), or null. */
  step: MonitoringStepSchema.nullable(),
  /** Title of the blocking prompt this session is sitting at, or null. */
  atPrompt: z.string().min(1).max(256).nullable(),
  /** Fleet address of the session this one is waiting for, or null. */
  waitingFor: z.string().min(1).max(256).nullable(),
  /** True when the session is in the durable sleeping state (running: false, state: 'stopped'). */
  sleeping: z.boolean(),
  /** True when the session is pinned awake against auto-sleep and unforced manual sleep. */
  pinned: z.boolean(),
  /** Measured process-tree memory in bytes (phys_footprint on macOS, PSS+SwapPss on Linux); 0 when stopped/sleeping, null when unavailable. */
  memoryBytes: z.number().int().nonnegative().nullable(),
  /** Current registration generation UUID when assigned, or null. */
  registrationGeneration: z.uuid().nullable(),
  /** The session's process boundary (`src/session/boundary.ts`) while it runs, or null. */
  boundary: SessionBoundarySchema.nullable(),
  observedAt: z.iso.datetime(),
});
export type MonitoringRow = z.infer<typeof MonitoringRowSchema>;

/**
 * A row as a consumer reads it from a producer of any protocol-1 version. A `state` or `agent` the
 * reader does not know reads as `unknown`; a field the reader does not know is dropped; a field a
 * producer added after protocol 1 may be absent. Identities, timestamps and bounds stay strict: a
 * row that breaks them is not a newer row, it is a broken one.
 */
export const MonitoringRowReadSchema = MonitoringRowSchema.extend({
  agent: z.union([AgentKindSchema, z.literal('unknown')]).catch('unknown'),
  state: MonitoringRowSchema.shape.state.catch('unknown'),
  startedAt: MonitoringRowSchema.shape.startedAt.optional(),
  step: MonitoringRowSchema.shape.step.optional(),
  atPrompt: MonitoringRowSchema.shape.atPrompt.optional(),
  waitingFor: MonitoringRowSchema.shape.waitingFor.optional(),
  sleeping: MonitoringRowSchema.shape.sleeping.optional(),
  pinned: MonitoringRowSchema.shape.pinned.optional(),
  memoryBytes: MonitoringRowSchema.shape.memoryBytes.optional(),
  registrationGeneration: MonitoringRowSchema.shape.registrationGeneration.optional(),
  boundary: MonitoringRowSchema.shape.boundary.optional(),
});
export type MonitoringRowRead = z.infer<typeof MonitoringRowReadSchema>;

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

/** The snapshot as a consumer reads it: the producer's envelope with tolerant rows. */
export const MonitoringSnapshotReadSchema = MonitoringSnapshotSchema.extend({
  sessions: z.array(MonitoringRowReadSchema).max(STATUS_MAX_ITEMS),
});
export type MonitoringSnapshotRead = z.infer<typeof MonitoringSnapshotReadSchema>;

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
    snapshot: MonitoringSnapshotReadSchema.nullable(),
  })
  .strict();
export type MonitoringRead = z.infer<typeof MonitoringReadSchema>;
