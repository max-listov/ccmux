import { z } from 'zod';
import {
  CONNECTION_REASONS,
  type ConnectionReason,
  ExternalTurnStateSchema,
  remedyFor,
} from './turnSchema.ts';

const CONNECTION_REASON_SET: ReadonlySet<string> = new Set(CONNECTION_REASONS);

export const EXTERNAL_MAX_ROWS = 512;
export const EXTERNAL_MAX_BYTES = 1024 * 1024;
export const EXTERNAL_MAX_READERS = 32;
export const EXTERNAL_INTERVAL_MS = 2000;
export const EXTERNAL_TTL_MS = 5000;
export const ExternalStatusRowSchema = z
  .object({
    identity: z
      .object({
        provider: z.literal('codex'),
        machine: z.string().min(1).max(128),
        threadId: z.uuid(),
      })
      .strict(),
    name: z.string().max(4096).nullable(),
    dir: z.string().max(4096).nullable(),
    updatedAt: z.iso.datetime().nullable(),
    turnState: ExternalTurnStateSchema,
  })
  .strict();
export type ExternalStatusRow = z.infer<typeof ExternalStatusRowSchema>;
export const ExternalStatusSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    version: z.string().max(64),
    machine: z.string().min(1).max(128),
    generation: z.uuid(),
    sequence: z.number().int().nonnegative(),
    source: z.literal('codex-app-server'),
    status: z.enum(['live', 'stale', 'unavailable']),
    reason: z
      .enum([
        'observation-pending',
        ...CONNECTION_REASONS,
        'unsupported-runtime',
        'deadline',
        'invalid-response',
        'config-changed',
        'daemon-stopped',
        'observation-expired',
        'clock-skew',
      ])
      .nullable(),
    observedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    truncated: z.boolean(),
    omitted: z.number().int().nonnegative(),
    sessions: z.array(ExternalStatusRowSchema).max(EXTERNAL_MAX_ROWS),
  })
  .strict();
export type ExternalStatusSnapshot = z.infer<typeof ExternalStatusSnapshotSchema>;

/** Transport health does not prove that a thread is loaded by this particular runtime. */
export function currentExternalStatus(
  snapshot: ExternalStatusSnapshot,
  now = Date.now(),
): ExternalStatusSnapshot {
  const current = structuredClone(snapshot);
  if (current.observedAt !== null && Date.parse(current.observedAt) > now) {
    current.status = 'unavailable';
    current.reason = 'clock-skew';
  } else if (
    current.status === 'live' &&
    (current.expiresAt === null || Date.parse(current.expiresAt) <= now)
  ) {
    current.status = 'stale';
    current.reason = 'observation-expired';
  }
  for (const row of current.sessions) {
    const state = row.turnState;
    if (
      state.evidence === 'observed' &&
      (current.status !== 'live' ||
        state.expiresAt === null ||
        Date.parse(state.expiresAt) <= now ||
        (state.observedAt !== null && Date.parse(state.observedAt) > now))
    ) {
      state.state = 'unknown';
      state.turnId = null;
      state.startedAt = null;
      state.evidence = current.status === 'unavailable' ? 'unavailable' : 'stale';
      // The row keeps the SNAPSHOT's own cause when that cause is a connection one: rewriting it to
      // the generic name here would throw away the distinction the observer just established, one
      // layer below, and hand the consumer back the unactionable word this all started with.
      state.reason =
        current.status !== 'unavailable'
          ? 'deadline'
          : current.reason !== null && CONNECTION_REASON_SET.has(current.reason)
            ? (current.reason as ConnectionReason)
            : 'connection-unavailable';
      state.remedy = remedyFor(state.reason);
    }
  }
  return current;
}
