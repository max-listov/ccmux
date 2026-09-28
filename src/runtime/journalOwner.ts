import { dirname, join } from 'node:path';
import { type DiagnosticJournal, DiagnosticJournalStatusSchema } from 'stitchkit/application';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { withLock } from '../util/lock.ts';
import { recordRuntimeDiagnostic } from './diagnostics.ts';
import {
  createRuntimeJournal,
  type RuntimeJournalEvent,
  type RuntimeJournalWriter,
  runtimeJournalPath,
} from './journal.ts';
import { privateRuntimeDirectory } from './store.ts';

/** The lifetime lock serializes this machine's writers and waits out one that is still closing.
 * Inside it, a journal lock left by a crash is reclaimed by the journal itself, and only when its
 * recorded owner is provably gone: another boot, or the same pid born at another moment. A pid
 * reused after a crash reboot is therefore not mistaken for the writer. A live owner, an owner
 * whose identity cannot be read and a lock from before identities were recorded all refuse;
 * journal data is never removed for recovery. */
export async function openOwnedRuntimeJournal(m: MachineConfig, writer: RuntimeJournalWriter) {
  const path = runtimeJournalPath(m, writer);
  privateRuntimeDirectory(join(m.stateDir, 'native-diagnostics'));
  privateRuntimeDirectory(dirname(path));
  const ready = Promise.withResolvers<DiagnosticJournal<RuntimeJournalEvent>>();
  const stopping = Promise.withResolvers<void>();
  let recovered = false;
  const lifecycle = withLock(
    `${path}.owner-lock`,
    async () => {
      let journal: DiagnosticJournal<RuntimeJournalEvent> | undefined;
      const failures: unknown[] = [];
      try {
        journal = await createRuntimeJournal(m, writer, (failure) =>
          recordRuntimeDiagnostic(
            m,
            writer.kind === 'daemon' ? null : writer.registration,
            `journal-${failure.phase}`,
            failure.error,
          ),
        );
        recovered = journal.getStatus().lock.reclaimedStale;
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
