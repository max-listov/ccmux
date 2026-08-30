export interface RuntimeLease {
  pid: number;
  providerPid: number;
  connected: boolean;
  reason: string | null;
  observedAt: string;
  expiresAt: string;
}

/** Process evidence and a bounded lease are shared; provider identity is never rewritten. */
export function readRuntimeLease(
  snapshot: RuntimeLease,
  now: number,
  ttlMs: number,
): { status: 'live' | 'stale' | 'unavailable'; reason: string | null } {
  for (const pid of [snapshot.pid, snapshot.providerPid]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') continue;
      return { status: 'unavailable', reason: 'producer-stopped' };
    }
  }
  if (!snapshot.connected)
    return { status: 'unavailable', reason: snapshot.reason ?? 'disconnected' };
  const observed = Date.parse(snapshot.observedAt);
  const expires = Date.parse(snapshot.expiresAt);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    now < observed ||
    expires < observed ||
    expires - observed > ttlMs
  )
    return { status: 'unavailable', reason: 'clock-skew' };
  return now >= expires ? { status: 'stale', reason: 'expired' } : { status: 'live', reason: null };
}
