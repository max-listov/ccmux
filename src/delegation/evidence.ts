import { join } from 'node:path';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJson } from '../runtime/store.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { verifyDelegatedSession } from './resolve.ts';
import { DelegationEvidenceSchema } from './schema.ts';

export async function recordDelegationApplied(m: MachineConfig, session: Session): Promise<void> {
  if (session.delegation === undefined) return;
  verifyDelegatedSession(session);
  const root = managedRuntimeRoot(m, session);
  privateRuntimeDirectory(root);
  await atomicWrite(
    join(root, 'delegation.json'),
    JSON.stringify(
      DelegationEvidenceSchema.parse({
        delegation: session.delegation,
        state: 'applied',
        generation: session.registrationGeneration ?? null,
        observedAt: new Date().toISOString(),
      }),
    ),
    0o600,
  );
}
export function readDelegationEvidence(m: MachineConfig, session: Session) {
  if (session.delegation === undefined) return undefined;
  const record = readPrivateJson(
    join(managedRuntimeRoot(m, session), 'delegation.json'),
    DelegationEvidenceSchema,
    16384,
  );
  const live = readManagedRuntimeStatus(m, session);
  if (
    record?.delegation.policyDigest === session.delegation.policyDigest &&
    record.generation === session.registrationGeneration &&
    live.status === 'live'
  )
    return record;
  return DelegationEvidenceSchema.parse({
    delegation: session.delegation,
    state: 'unavailable',
    generation: session.registrationGeneration ?? null,
    observedAt: new Date().toISOString(),
  });
}
