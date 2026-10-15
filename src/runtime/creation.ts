import { AppError } from 'stitchkit';
import type { Session } from '../types.ts';
import { runtimeCapabilities } from './capabilities.ts';

/** Admission is checked before discovery and again at the provider boundary, including restart. */
export function assertInferenceFreeCreate(
  input: Pick<Session, 'agent' | 'runtime' | 'modelSelection'> & {
    initialization?: 'allow-inference' | 'no-inference' | undefined;
    delegation?: unknown;
  },
): void {
  if (input.initialization !== 'no-inference') return;
  const creation = runtimeCapabilities({ agent: input.agent, runtime: input.runtime }).creation;
  if (!creation.noInference)
    throw new AppError('NO_INFERENCE_CREATE_UNSUPPORTED', {
      message: `No-inference create is unsupported: ${creation.reason}`,
      status: 409,
    });
  if (
    input.delegation === undefined ||
    input.modelSelection?.provider !== 'claude' ||
    input.modelSelection.model === 'default'
  )
    throw new AppError('NO_INFERENCE_CREATE_REQUIREMENTS', {
      message: 'No-inference create requires immutable delegation and an explicit provider/model',
      status: 409,
    });
}
