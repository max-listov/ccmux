import { join } from 'node:path';
import { z } from 'zod';
import { isDescendantProcess, processSnapshot } from '../external/processes.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { managedRuntimeRoot } from './status.ts';
import { privateRuntimeDirectory, readPrivateJson } from './store.ts';

const ProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    startTime: z.string(),
    processGroup: z.number().int().positive(),
  })
  .strict();
const OwnershipSchema = z
  .object({
    registrationGeneration: z.uuid(),
    owner: ProcessIdentitySchema,
    provider: ProcessIdentitySchema,
    baseline: z.array(ProcessIdentitySchema).max(256),
  })
  .strict();
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'owned-process.json');
/** Recorded by the process that actually spawned the provider, never reconstructed from a name. */
export async function registerRuntimeOwnership(
  m: MachineConfig,
  s: Session,
  providerPid: number,
): Promise<void> {
  const rows = processSnapshot();
  const owner = rows?.find((row) => row.pid === process.pid);
  const provider = rows?.find((row) => row.pid === providerPid);
  if (
    rows === null ||
    owner === undefined ||
    provider === undefined ||
    !isDescendantProcess(rows, providerPid, process.pid)
  )
    throw Error('Native process ownership cannot be measured');
  const identity = (row: typeof owner) => ({
    pid: row.pid,
    startTime: row.startTime,
    processGroup: row.processGroup,
  });
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  await atomicWrite(
    path(m, s),
    JSON.stringify(
      OwnershipSchema.parse({
        registrationGeneration: s.registrationGeneration,
        owner: identity(owner),
        provider: identity(provider),
        baseline: rows
          .filter(
            (row) =>
              row.pid === process.pid ||
              row.processGroup === provider.processGroup ||
              isDescendantProcess(rows, row.pid, process.pid),
          )
          .map(identity),
      }),
    ),
    0o600,
  );
}
export function readRuntimeOwnership(m: MachineConfig, s: Session) {
  const row = readPrivateJson(path(m, s), OwnershipSchema, 8192);
  return row?.registrationGeneration === s.registrationGeneration ? row : null;
}
