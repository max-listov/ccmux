import { join } from 'node:path';
import type { DiagnosticJournalFailure, DiagnosticJournalLimits } from 'stitchkit/application';
import { createDiagnosticJournal } from 'stitchkit/application/diagnostic-journal';
import { z } from 'zod';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import type { MachineConfig } from '../types.ts';

/** Metadata only. Prompts, tool arguments, native errors and names have no field here. */
export const RuntimeJournalEventSchema = z
  .object({
    at: z.iso.datetime(),
    kind: z.enum([
      'started',
      'admitted',
      'bound',
      'observer-gap',
      'request-pending',
      'request-answered',
      'interrupt-requested',
      'recovery',
      'terminal',
      'stopping',
      'stopped',
    ]),
    runtime: z.enum(['daemon', 'codex', 'opencode', 'custom', 'claude']),
    registration: z.uuid().optional(),
    messageId: z.uuid().optional(),
    // Native opaque IDs stay in their canonical stores; diagnostics use digest correlation.
    nativeIdentityHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    generation: z.uuid().optional(),
    outcome: z.enum(['success', 'failed', 'interrupted', 'held', 'unavailable']).optional(),
    omitted: z.int().nonnegative().optional(),
  })
  .strict();
export type RuntimeJournalEvent = z.infer<typeof RuntimeJournalEventSchema>;

export const RUNTIME_JOURNAL_LIMITS: DiagnosticJournalLimits = {
  maxEventBytes: 8 * 1024,
  maxPendingItems: 256,
  maxPendingBytes: 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 4,
};
const WriterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daemon') }).strict(),
  z.object({ kind: z.literal('worker'), registration: z.uuid() }).strict(),
]);
export type RuntimeJournalWriter = z.infer<typeof WriterSchema>;

export function runtimeJournalPath(
  m: Pick<MachineConfig, 'stateDir'>,
  input: RuntimeJournalWriter,
): string {
  const writer = WriterSchema.parse(input);
  return join(
    m.stateDir,
    'native-diagnostics',
    'journals',
    writer.kind === 'daemon' ? 'daemon.jsonl' : `worker-${writer.registration}.jsonl`,
  );
}

/**
 * The owning process supplies its lifetime and failure sink. A stale lock refuses startup;
 * only supervisor evidence that its former writer died may authorize lock recovery.
 * This journal is not an admission store, fsync receipt or message completion authority.
 */
export async function createRuntimeJournal(
  m: Pick<MachineConfig, 'stateDir'>,
  writer: RuntimeJournalWriter,
  onFailure: (failure: DiagnosticJournalFailure) => void | Promise<void>,
) {
  privateRuntimeDirectory(join(m.stateDir, 'native-diagnostics'));
  privateRuntimeDirectory(join(m.stateDir, 'native-diagnostics', 'journals'));
  return createDiagnosticJournal({
    path: runtimeJournalPath(m, writer),
    eventSchema: RuntimeJournalEventSchema,
    limits: RUNTIME_JOURNAL_LIMITS,
    mode: 0o600,
    onFailure,
  });
}
