import { lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type DiagnosticJournal, DiagnosticJournalStatusSchema } from 'stitchkit/application';
import { z } from 'zod';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { withDirectoryLock } from '../config/registryLock.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { recordRuntimeDiagnostic } from './diagnostics.ts';
import {
  createRuntimeJournal,
  type RuntimeJournalEvent,
  type RuntimeJournalWriter,
  runtimeJournalPath,
} from './journal.ts';
import { readPrivateJson } from './store.ts';

const ClaimSchema = z.object({ pid: z.int().positive(), epoch: z.uuid() }).strict();
async function recover(path: string): Promise<boolean> {
  try {
    const lock = await lstat(`${path}.lock`);
    if (
      !lock.isFile() ||
      lock.isSymbolicLink() ||
      lock.uid !== process.getuid?.() ||
      lock.mode & 0o077
    )
      throw new Error('Diagnostic writer lock is unsafe');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  const claim = readPrivateJson(`${path}.owner.json`, ClaimSchema, 1024);
  if (!claim) throw new Error('Diagnostic writer has no proven owner');
  try {
    process.kill(claim.pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      await unlink(`${path}.lock`);
      return true;
    }
    throw error;
  }
  throw new Error('Diagnostic writer is still alive');
}

/** The upstream lock is not a crash lease. An owner-aware lifetime lock serializes our own
 * writers, and a private PID claim proves death before removing only a stale upstream lock.
 * An unclaimed lock or live/reused PID fails closed; journal data is never removed for recovery. */
export async function openOwnedRuntimeJournal(m: MachineConfig, writer: RuntimeJournalWriter) {
  const path = runtimeJournalPath(m, writer);
  privateRuntimeDirectory(join(m.stateDir, 'native-diagnostics'));
  privateRuntimeDirectory(dirname(path));
  const ready = Promise.withResolvers<DiagnosticJournal<RuntimeJournalEvent>>();
  const stopping = Promise.withResolvers<void>();
  let recovered = false;
  const lifecycle = withDirectoryLock(
    `${path}.owner-lock`,
    async () => {
      let journal: DiagnosticJournal<RuntimeJournalEvent> | undefined;
      const failures: unknown[] = [];
      try {
        recovered = await recover(path);
        await atomicWrite(
          `${path}.owner.json`,
          JSON.stringify({ pid: process.pid, epoch: crypto.randomUUID() }),
          0o600,
        );
        journal = await createRuntimeJournal(m, writer, (failure) =>
          recordRuntimeDiagnostic(
            m,
            writer.kind === 'daemon' ? null : writer.registration,
            `journal-${failure.phase}`,
            failure.error,
          ),
        );
        ready.resolve(journal);
        await stopping.promise;
      } catch (error) {
        ready.reject(error);
        failures.push(error);
      }
      try {
        if (journal) {
          const result = await journal.close({ timeoutMs: 3000 });
          await atomicWrite(
            `${path}.status.json`,
            JSON.stringify(DiagnosticJournalStatusSchema.parse(journal.getStatus())),
            0o600,
          );
          if (result.outcome !== 'closed' || result.state === 'failed')
            throw new Error('Diagnostic journal did not close cleanly');
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Diagnostic journal lifecycle failed');
    },
    'diagnostic journal owner',
  );
  // Attach rejection before ready can fail; callers still receive the actual failure on close.
  void lifecycle.catch((error) => ready.reject(error));
  const journal = await ready.promise;
  let lastStatus = 0;
  let publishing: Promise<void> | null = null;
  let diagnosticFailure: unknown = null;
  return {
    recovered,
    submit(event: RuntimeJournalEvent) {
      const result = journal.submit(event);
      if (result.outcome === 'refused')
        void recordRuntimeDiagnostic(
          m,
          writer.kind === 'daemon' ? null : writer.registration,
          'journal-refusal',
          result,
        ).catch((error) => {
          diagnosticFailure = error;
        });
      return result;
    },
    status: () => journal.getStatus(),
    async publishStatus() {
      if (diagnosticFailure !== null) throw diagnosticFailure;
      if (Date.now() - lastStatus < 1000 || publishing) return;
      lastStatus = Date.now();
      publishing = atomicWrite(`${path}.status.json`, JSON.stringify(journal.getStatus()), 0o600);
      try {
        await publishing;
      } finally {
        publishing = null;
      }
    },
    async close() {
      await publishing;
      stopping.resolve();
      await lifecycle;
    },
  };
}
export type OwnedRuntimeJournal = Awaited<ReturnType<typeof openOwnedRuntimeJournal>>;
