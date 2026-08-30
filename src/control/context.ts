import { AppError } from 'stitchkit';
import type { z } from 'zod';
import {
  compactNativeContext,
  readContextOperation,
  readNativeHistory,
} from '../context/service.ts';
import { hasNativeRuntime, runtimeCapabilities } from '../runtime/capabilities.ts';
import type { MachineConfig } from '../types.ts';
import {
  type ControlCompactSchema,
  type ControlContextOperationReadSchema,
  type ControlHistoryReadSchema,
  PublicContextOperationSchema,
} from './contextSchema.ts';
import { controlTarget } from './target.ts';

function exactTarget(
  m: MachineConfig,
  input:
    | z.output<typeof ControlHistoryReadSchema>
    | z.output<typeof ControlCompactSchema>
    | z.output<typeof ControlContextOperationReadSchema>,
) {
  const session = controlTarget(m, input.target);
  if (session.registrationGeneration !== input.registrationGeneration)
    throw new AppError('IDENTITY_MISMATCH', 'The exact managed registration is unavailable', 409);
  if (session.archived || !hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'Native context controls are unavailable', 409);
  return session;
}
export async function readControlHistory(
  m: MachineConfig,
  input: z.output<typeof ControlHistoryReadSchema>,
  signal: AbortSignal,
) {
  const session = exactTarget(m, input);
  if (!runtimeCapabilities(session).history)
    throw new AppError('UNSUPPORTED', 'Native history is unavailable', 409);
  const page = await readNativeHistory(
    m,
    session,
    { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
    signal,
  );
  exactTarget(m, input);
  return { ...page, target: input.target, registrationGeneration: input.registrationGeneration };
}
export async function compactControlContext(
  m: MachineConfig,
  input: z.output<typeof ControlCompactSchema>,
  signal: AbortSignal,
) {
  const session = exactTarget(m, input);
  if (!runtimeCapabilities(session).compaction)
    throw new AppError('UNSUPPORTED', 'Native compaction is unavailable', 409);
  const operation = await compactNativeContext(
    m,
    session,
    { operationId: input.operationId, generation: input.generation },
    signal,
  );
  return {
    target: input.target,
    registrationGeneration: input.registrationGeneration,
    operation: PublicContextOperationSchema.parse(operation),
  };
}
export function readControlContextOperation(
  m: MachineConfig,
  input: z.output<typeof ControlContextOperationReadSchema>,
) {
  const operation = readContextOperation(m, exactTarget(m, input), input.operationId);
  return {
    target: input.target,
    registrationGeneration: input.registrationGeneration,
    operation: operation === null ? null : PublicContextOperationSchema.parse(operation),
  };
}
