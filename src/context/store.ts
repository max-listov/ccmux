import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { withDirectoryLock } from '../config/registryLock.ts';
import { managedRuntimeRoot } from '../runtime/status.ts';
import { readPrivateJson } from '../runtime/store.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { ContextOperationSchema } from './schema.ts';

const JournalSchema = z
  .object({
    registration: z.uuid(),
    nativeId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative(),
    lastCompletion: z
      .object({ generation: z.uuid(), id: z.string().min(1).max(1_024) })
      .strict()
      .nullable()
      .default(null),
    operations: z.array(ContextOperationSchema).max(256),
  })
  .strict();
export type ContextJournal = z.infer<typeof JournalSchema>;
export const contextPath = (m: MachineConfig, s: Session, file: string) =>
  join(managedRuntimeRoot(m, s), file);
export const nativeId = (s: Session) => (s.agent === 'codex' ? s.uuid : s.nativeSession?.id);
export function readContextJournal(m: MachineConfig, s: Session): ContextJournal {
  const path = contextPath(m, s, 'context.json');
  const value = readPrivateJson(path, JournalSchema);
  if (value === null && existsSync(path))
    throw new AppError('CONTEXT_UNAVAILABLE', 'Native context state is unavailable', 503);
  if (!s.registrationGeneration || !nativeId(s))
    throw new AppError('CONTEXT_UNAVAILABLE', 'Native context identity is unavailable', 503);
  if (value !== null) {
    if (value.registration !== s.registrationGeneration || value.nativeId !== nativeId(s))
      throw new AppError('CONTEXT_UNAVAILABLE', 'Native context identity changed', 409);
    return value;
  }
  return JournalSchema.parse({
    registration: s.registrationGeneration,
    nativeId: nativeId(s),
    revision: 0,
    lastCompletion: null,
    operations: [],
  });
}
export async function withContextJournal<T>(
  m: MachineConfig,
  s: Session,
  run: (journal: ContextJournal, persist: () => Promise<void>) => Promise<T>,
) {
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  return withDirectoryLock(
    contextPath(m, s, 'context.lock'),
    async () => {
      const journal = readContextJournal(m, s);
      return run(journal, () =>
        atomicWrite(
          contextPath(m, s, 'context.json'),
          JSON.stringify(JournalSchema.parse(journal)),
          0o600,
        ),
      );
    },
    'native context',
  );
}
export function assertNoContextMutation(m: MachineConfig, s: Session): void {
  if (contextMutationPending(m, s))
    throw new AppError('CONTEXT_BUSY', 'A native context operation is unresolved', 409);
}
export function contextMutationPending(m: MachineConfig, s: Session): boolean {
  return readContextJournal(m, s).operations.some(
    (row) => !['completed', 'rejected'].includes(row.state),
  );
}
