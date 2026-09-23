import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { withNativeAdmission } from './admission.ts';
import {
  type AcceptedTurnOptions,
  AcceptedTurnOptionsSchema,
  type NativeTurnOptions,
} from './selectionSchema.ts';
import { managedRuntimeRoot } from './status.ts';
import { privateRuntimeDirectory, readPrivateJson } from './store.ts';

const ReceiptSchema = z
  .object({
    operationId: z.uuid(),
    fingerprint: z.string().length(64),
    result: AcceptedTurnOptionsSchema,
  })
  .strict();
const SelectionStoreSchema = z
  .object({
    registrationGeneration: z.uuid(),
    current: AcceptedTurnOptionsSchema,
    receipts: z.array(ReceiptSchema).max(256),
  })
  .strict();
const selectionPath = (m: MachineConfig, s: Session) =>
  join(managedRuntimeRoot(m, s), 'selection.json');

/** Create-time model/flags remain immutable; this register only describes future CCMux turns. */
function readStore(m: MachineConfig, s: Session) {
  const path = selectionPath(m, s);
  const row = readPrivateJson(path, SelectionStoreSchema, 256 * 1024);
  if (row === null) {
    if (existsSync(path))
      throw new AppError('SELECTION_UNAVAILABLE', 'Session selection is unavailable', 409);
    return null;
  }
  if (
    row.registrationGeneration !== s.registrationGeneration ||
    row.current.options.runtime !== s.agent
  )
    throw new AppError(
      'IDENTITY_MISMATCH',
      'Session selection belongs to another registration',
      409,
    );
  return row;
}

export const readSelection = (m: MachineConfig, s: Session): AcceptedTurnOptions | null =>
  readStore(m, s)?.current ?? null;
/** Replay an operation only when its canonical request fingerprint matches. */
export function selectionReceipt(
  m: MachineConfig,
  s: Session,
  operationId: string,
  fingerprint: string,
): AcceptedTurnOptions | null {
  const store = readStore(m, s);
  const prior = store?.receipts.find((row) => row.operationId === operationId);
  if (prior !== undefined) {
    if (fingerprint !== prior.fingerprint)
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Selection request changed', 409);
    return prior.result;
  }
  if ((store?.receipts.length ?? 0) >= 256)
    throw new AppError('CAPACITY', 'Selection journal capacity reached', 409);
  return null;
}

/** Caller holds the shared native admission lock and has validated the catalog and live state. */
export async function writeSelection(
  m: MachineConfig,
  s: Session,
  value: AcceptedTurnOptions,
  operationId: string,
  fingerprint: string,
): Promise<void> {
  if (s.registrationGeneration === undefined)
    throw new AppError('UNSUPPORTED', 'Managed registration is required', 409);
  const prior = readStore(m, s);
  const row = SelectionStoreSchema.parse({
    current: value,
    registrationGeneration: s.registrationGeneration,
    receipts: [...(prior?.receipts ?? []), { operationId, fingerprint, result: value }],
  });
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  await atomicWrite(selectionPath(m, s), JSON.stringify(row), 0o600);
}

/** The native admission response, not a catalog default, supplies the initial selection. */
export async function seedNativeSelection(
  m: MachineConfig,
  s: Session,
  options: NativeTurnOptions,
): Promise<void> {
  await withNativeAdmission(m, s, async () => {
    if (readStore(m, s) !== null) return;
    const row = SelectionStoreSchema.parse({
      registrationGeneration: s.registrationGeneration,
      current: { revision: 0, options },
      receipts: [],
    });
    privateRuntimeDirectory(managedRuntimeRoot(m, s));
    await atomicWrite(selectionPath(m, s), JSON.stringify(row), 0o600);
  });
}

/**
 * The turn options a session starts with before any turn has chosen its own: the model it was
 * created with and, for Codex, the collaboration mode its launch recipe names.
 *
 * Every native runtime has one — without Claude's, every control-plane message to a native Claude
 * session was refused before it reached the ledger, since `message.send` reads the current
 * selection first. Effort is a per-turn choice a caller makes, so no default carries one: inventing
 * one here would apply a thinking budget nobody asked for to every turn.
 */
export function initialTurnOptions(
  s: Session,
  model: NonNullable<Session['modelSelection']>,
): NativeTurnOptions {
  switch (s.agent) {
    case 'codex':
      return { runtime: 'codex', model, mode: s.launchRecipe?.collaborationMode ?? 'default' };
    case 'opencode':
      return { runtime: 'opencode', model };
    case 'custom':
      return { runtime: 'custom', model };
    case 'claude':
      return { runtime: 'claude', model };
  }
}
