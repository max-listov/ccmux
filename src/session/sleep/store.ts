import { join } from 'node:path';
import { refusals } from '../../control/schema/refusals.ts';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJournal } from '../../runtime/store.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { log } from '../../util/log.ts';
import { type SleepRecord, SleepRecordSchema } from './schema.ts';

const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'sleep.json');

export function readSleep(m: MachineConfig, s: Session): SleepRecord | null {
  const file = path(m, s);
  const row = readPrivateJournal(file, SleepRecordSchema, 65536);
  if (
    row !== null &&
    (row.target.threadId !== s.uuid ||
      (s.registrationGeneration !== undefined &&
        row.registrationGeneration !== s.registrationGeneration))
  )
    throw refusals.errors.IDENTITY_MISMATCH({ message: 'Sleep registration changed' });
  return row;
}

/** Fault-isolated read for multi-session daemon loops: one corrupt `sleep.json` never aborts siblings. */
export function readSleepSafe(m: MachineConfig, s: Session): SleepRecord | null {
  try {
    return readSleep(m, s);
  } catch (error) {
    log.warn({ msg: 'ignoring unreadable sleep record', name: s.name, err: String(error) });
    return null;
  }
}

export async function writeSleep(m: MachineConfig, s: Session, row: SleepRecord): Promise<void> {
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  await atomicWrite(path(m, s), JSON.stringify(SleepRecordSchema.parse(row)), 0o600);
}

export function sleepBlocksStart(m: MachineConfig, s: Session): boolean {
  const row = readSleepSafe(m, s);
  return row !== null && row.phase !== 'awake' && row.phase !== 'waking';
}

/**
 * Whether a session is shown as sleeping — the one answer `list`, `fleet`, `whois`, monitoring, the
 * control rows and `inbox` give. A sleep that is requested or done, on a session that is not
 * archived and not running. `waking` is not sleeping: the session is coming up, and a letter to it
 * is held under its own kind until it is awake. A process still tearing down keeps reporting live
 * state rather than a premature sleep.
 */
export function showsAsSleeping(m: MachineConfig, s: Session, running: boolean | null): boolean {
  return !s.archived && running !== true && sleepBlocksStart(m, s);
}

/** True whenever a sleep record is not settled awake (`requested`, `sleeping`, or `waking`). */
export function sleepUnsettled(m: MachineConfig, s: Session): boolean {
  const row = readSleepSafe(m, s);
  return row !== null && row.phase !== 'awake';
}

/** Read by the owner itself; no process selected by name is ever signalled. */
export function ownerShouldSleep(m: MachineConfig, s: Session): boolean {
  const row = readSleepSafe(m, s);
  return (
    row?.phase === 'requested' && row.proof.processes.some((entry) => entry.pid === process.pid)
  );
}
