import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { AgentKindSchema } from '../chat/identitySchema.ts';
import type { ResolvedControlLaunch } from '../config/launchRecipes.ts';
import { LaunchRecipeMetadataSchema, ModelSelectionSchema } from '../config/launchSchema.ts';
import { type NativeForkSource, NativeForkSourceSchema } from '../context/fork.ts';
import {
  type ApplicationPolicyMetadata,
  ApplicationPolicyMetadataSchema,
} from '../policy/schema.ts';
import { privateRuntimeDirectory } from '../runtime/store.ts';
import { loadSessions } from '../session/registry.ts';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import type { ControlCreateSchema } from './schema/session.ts';

export type CreateInput = z.input<typeof ControlCreateSchema>;

export const CreateRowSchema = z
  .object({
    runtime: AgentKindSchema.optional(),
    requestId: z.uuid(),
    fingerprint: z.string().length(64),
    generation: z.uuid(),
    name: z.string(),
    workspace: z.string(),
    flags: z.array(z.string()),
    envFile: z.string().min(1).optional(),
    launchRecipe: LaunchRecipeMetadataSchema.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    applicationPolicy: ApplicationPolicyMetadataSchema.optional(),
    /** The execution mode the caller asked for, where the agent offers a choice. */
    mode: z.enum(['tui', 'native']).optional(),
    forkSource: NativeForkSourceSchema.optional(),
    status: z.enum(['pending', 'complete', 'failed']),
    threadId: z.uuid().nullable(),
    error: z.string().max(512).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type CreateRow = z.infer<typeof CreateRowSchema>;

export type ForkAdmission = {
  source: NativeForkSource;
  launch: ResolvedControlLaunch & { applicationPolicy?: ApplicationPolicyMetadata };
};

export const StoreSchema = z.array(CreateRowSchema).max(256);

export const storePath = (m: Pick<MachineConfig, 'stateDir'>) =>
  join(m.stateDir, 'control', 'create-requests.json');

export const storeLockPath = (m: Pick<MachineConfig, 'stateDir'>) =>
  join(m.stateDir, 'control', 'create-requests.lock');

export const requestLockPath = (m: Pick<MachineConfig, 'stateDir'>, requestId: string) =>
  join(
    m.stateDir,
    'control',
    `create-${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}.lock`,
  );

export function loadCreateReceipts(m: MachineConfig): CreateRow[] {
  const path = storePath(m);
  if (!existsSync(path)) return [];
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 512 * 1024
    ) {
      throw new Error('unsafe create receipt store');
    }
    return StoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new AppError('CORRUPT_STATE', 'Create receipt store is unavailable', 503);
  }
}

export async function saveCreateReceipts(m: MachineConfig, rows: CreateRow[]): Promise<void> {
  privateRuntimeDirectory(dirname(storePath(m)));
  await atomicWrite(storePath(m), JSON.stringify(StoreSchema.parse(rows)), 0o600);
}

export const fingerprint = (input: {
  name: string;
  workspace: string;
  flags: string[];
  envFile?: string;
  launchRecipe?: unknown;
}) => createHash('sha256').update(stableJson(input)).digest('hex');

export function normalizeWorkspace(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    throw new AppError('INVALID_WORKSPACE', 'Workspace does not exist', 400);
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory())
    throw new AppError('INVALID_WORKSPACE', 'Workspace is not a directory', 400);
  return resolved;
}

export function matchingSession(m: MachineConfig, row: CreateRow): Session | null {
  return (
    loadSessions(m).find(
      (session) => session.name === row.name && session.registrationGeneration === row.generation,
    ) ?? null
  );
}

/**
 * A create that already finished, by the id the caller retries with.
 *
 * The receipt is durable and settled, so answering from it does no work — which is what lets a retry
 * skip the per-request admission slot instead of being refused for concurrency. Measured on a live
 * consumer: the first attempt's answer was lost to a transport timeout while the session was
 * created anyway, and the two retries carrying the SAME request id came back BUSY — leaving a caller
 * that cannot tell "still running" from "already done", which is the one thing an idempotent retry
 * exists to tell it. `pending` deliberately does not qualify: two runs of one create are a race.
 */
export function settledCreateRequest(m: MachineConfig, requestId: string): boolean {
  return loadCreateReceipts(m).some(
    (row) => row.requestId === requestId && row.status === 'complete',
  );
}
