import { dirname } from 'node:path';
import type { z } from 'zod';
import { atomicWrite } from '../util/atomic.ts';
import { readRuntimeLease } from './lease.ts';
import { NATIVE_RUNTIME_MAX_BYTES, NATIVE_RUNTIME_TTL_MS } from './projectionSchema.ts';
import type { ManagedRuntimeRead, ManagedRuntimeSnapshot } from './schema.ts';
import { privateRuntimeDirectory } from './store.ts';

/*
 * The parts of a runtime's status file that do not depend on which runtime it is. A leaf module on
 * purpose: `status.ts` dispatches to the Codex reader, and the Codex writer is built from this — kept
 * in `status.ts`, the two would import each other and a class could be extended before it existed.
 */

/**
 * A snapshot read against its lease, for every native runtime. Codex's owned runtime used to have its
 * own copy of this that dropped the account with the state, so a stopped Codex session vanished from
 * `accounts` — the failure `retained` exists to prevent.
 */
export function validateRuntimeLiveness<Snapshot extends ManagedRuntimeSnapshot>(
  snapshot: Snapshot,
  now: number,
): Omit<ManagedRuntimeRead, 'snapshot'> & { snapshot: Snapshot | null } {
  const lease = readRuntimeLease(snapshot, now, NATIVE_RUNTIME_TTL_MS);
  const live = lease.status === 'live';
  return {
    protocol: 1,
    ...lease,
    snapshot: live ? snapshot : null,
    // The state goes, the identity stays. Everything a stale projection could lie about is dropped
    // above; which account this session was signed into is not one of those things.
    retained: live ? null : { account: snapshot.account ?? null },
  };
}

/**
 * One coalesced writer of a runtime's status file: the latest snapshot wins, one write at a time,
 * bounded independently of how often the runtime reports.
 */
export class RuntimeStatusWriter<Snapshot> {
  private next: Snapshot | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private path: string,
    private schema: z.ZodType<Snapshot>,
  ) {
    privateRuntimeDirectory(dirname(this.path));
  }

  write(snapshot: Snapshot): Promise<void> {
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
        const bytes = JSON.stringify(this.schema.parse(value));
        if (Buffer.byteLength(bytes) > NATIVE_RUNTIME_MAX_BYTES)
          throw new Error('Native projection exceeds its byte limit');
        await atomicWrite(this.path, bytes, 0o600);
      }
    } finally {
      this.writing = null;
    }
  }
}
