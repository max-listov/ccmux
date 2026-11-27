import type { z } from 'zod';
import {
  compactNativeContext,
  readContextOperation,
  readNativeHistory,
} from '../context/service.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { MachineConfig } from '../types.ts';
import {
  type ControlCompactSchema,
  type ControlContextOperationReadSchema,
  type ControlHistoryReadSchema,
  PublicContextOperationSchema,
} from './schema/context.ts';
import { refusals } from './schema/refusals.ts';
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
    throw refusals.errors.IDENTITY_MISMATCH({
      message: 'The exact managed registration is unavailable',
    });
  if (session.archived || !hasNativeRuntime(session))
    throw refusals.errors.UNSUPPORTED({ message: 'Native context controls are unavailable' });
  return session;
}
export async function readControlHistory(
  m: MachineConfig,
  input: z.output<typeof ControlHistoryReadSchema>,
  signal: AbortSignal,
) {
  const session = exactTarget(m, input);
  if (!runtimeCapabilities(session).history)
    throw refusals.errors.UNSUPPORTED({ message: 'Native history is unavailable' });
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
    throw refusals.errors.UNSUPPORTED({ message: 'Native compaction is unavailable' });
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
