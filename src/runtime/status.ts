import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { readOwnedCodexStatus } from '../agent/codex/ownedStatus.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { readRuntimeLease } from './lease.ts';
import { NATIVE_RUNTIME_MAX_BYTES, NATIVE_RUNTIME_TTL_MS } from './projectionSchema.ts';
import {
  type ManagedRuntimeRead,
  type ManagedRuntimeSnapshot,
  ManagedRuntimeSnapshotSchema,
} from './schema.ts';
import { readPrivateJson } from './store.ts';

export function managedRuntimeRoot(
  m: Pick<MachineConfig, 'stateDir'>,
  s: Pick<Session, 'name' | 'uuid'>,
): string {
  const key = createHash('sha256')
    .update(JSON.stringify([s.name, s.uuid]))
    .digest('hex')
    .slice(0, 32);
  return join(m.stateDir, 'native-runtime', key);
}

export function readManagedRuntimeStatus(
  m: MachineConfig,
  s: Session,
  now = Date.now(),
): ManagedRuntimeRead {
  if (s.agent === 'codex') return readOwnedCodexStatus(m, s, now);
  const snapshot = readPrivateJson(
    join(managedRuntimeRoot(m, s), 'status.json'),
    ManagedRuntimeSnapshotSchema,
    NATIVE_RUNTIME_MAX_BYTES,
  );
  if (snapshot === null)
    return { protocol: 1, status: 'unavailable', reason: 'unavailable', snapshot: null };
  if (
    snapshot.provider !== s.agent ||
    snapshot.machine !== m.rcPrefix ||
    snapshot.session !== s.name ||
    snapshot.threadId !== s.uuid ||
    snapshot.registrationGeneration !== s.registrationGeneration ||
    snapshot.nativeSession?.id !== s.nativeSession?.id ||
    snapshot.nativeSession?.runtime !== s.agent
  )
    return { protocol: 1, status: 'unavailable', reason: 'identity-mismatch', snapshot: null };
  return validateRuntimeLiveness(snapshot, now);
}

function validateRuntimeLiveness(
  snapshot: ManagedRuntimeSnapshot,
  now: number,
): ManagedRuntimeRead {
  const lease = readRuntimeLease(snapshot, now, NATIVE_RUNTIME_TTL_MS);
  return { protocol: 1, ...lease, snapshot: lease.status === 'live' ? snapshot : null };
}

export class ManagedRuntimeStatusWriter {
  private next: ManagedRuntimeSnapshot | null = null;
  private writing: Promise<void> | null = null;
  private path: string;

  constructor(m: MachineConfig, session: Session) {
    this.path = join(managedRuntimeRoot(m, session), 'status.json');
    privateRuntimeDirectory(dirname(this.path));
  }

  write(snapshot: ManagedRuntimeSnapshot): Promise<void> {
    this.next = snapshot;
    this.writing ??= this.drain();
    return this.writing;
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    try {
      while (this.next !== null) {
        const value = this.next;
        this.next = null;
        const bytes = JSON.stringify(ManagedRuntimeSnapshotSchema.parse(value));
        if (Buffer.byteLength(bytes) > NATIVE_RUNTIME_MAX_BYTES)
          throw new Error('Native projection exceeds its byte limit');
        await atomicWrite(this.path, bytes, 0o600);
      }
    } finally {
      this.writing = null;
    }
  }
}
