import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readOwnedCodexStatus } from '../agent/codex/owned/status.ts';
import type { MachineConfig, Session } from '../types.ts';
import { NATIVE_RUNTIME_MAX_BYTES } from './projectionSchema.ts';
import {
  type ManagedRuntimeRead,
  type ManagedRuntimeSnapshot,
  ManagedRuntimeSnapshotSchema,
} from './schema.ts';
import { RuntimeStatusWriter, validateRuntimeLiveness } from './statusFile.ts';
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
    return {
      protocol: 1,
      status: 'unavailable',
      reason: 'unavailable',
      snapshot: null,
      retained: null,
    };
  if (
    snapshot.provider !== s.agent ||
    snapshot.machine !== m.rcPrefix ||
    snapshot.session !== s.name ||
    snapshot.threadId !== s.uuid ||
    snapshot.registrationGeneration !== s.registrationGeneration ||
    snapshot.nativeSession?.id !== s.nativeSession?.id ||
    snapshot.nativeSession?.runtime !== s.agent
  )
    return {
      protocol: 1,
      status: 'unavailable',
      reason: 'identity-mismatch',
      snapshot: null,
      retained: null,
    };
  return validateRuntimeLiveness(snapshot, now);
}

/** The status writer for the runtimes whose state lives under `managedRuntimeRoot`. */
export class ManagedRuntimeStatusWriter extends RuntimeStatusWriter<ManagedRuntimeSnapshot> {
  constructor(m: MachineConfig, session: Session) {
    super(join(managedRuntimeRoot(m, session), 'status.json'), ManagedRuntimeSnapshotSchema);
  }
}
