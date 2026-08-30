import {
  type MonitoringRead,
  type MonitoringSnapshot,
  MonitoringSnapshotSchema,
  STATUS_MAX_AGE_MS,
} from './schema.ts';

export function unavailable(reason: MonitoringRead['reason']): MonitoringRead {
  return { protocol: 1, status: 'unavailable', reason, snapshot: null };
}

/** Rechecked at delivery too: a shared read is never a lease on producer liveness. */
export function validateLiveness(snapshot: MonitoringSnapshot, now = Date.now()): MonitoringRead {
  try {
    process.kill(snapshot.pid, 0);
  } catch {
    return unavailable('producer-stopped');
  }
  const age = now - Date.parse(snapshot.observedAt);
  if (age < 0) return { protocol: 1, status: 'stale', reason: 'clock-skew', snapshot: null };
  if (age > STATUS_MAX_AGE_MS)
    return { protocol: 1, status: 'stale', reason: 'expired', snapshot: null };
  return { protocol: 1, status: 'live', reason: null, snapshot };
}

export function validateSnapshot(
  bytes: string,
  rcPrefix: string,
  now = Date.now(),
): MonitoringRead {
  try {
    const parsed = MonitoringSnapshotSchema.safeParse(JSON.parse(bytes));
    if (!parsed.success || parsed.data.rcPrefix !== rcPrefix) return unavailable('invalid');
    return validateLiveness(parsed.data, now);
  } catch {
    return unavailable('invalid');
  }
}
