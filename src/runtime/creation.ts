import { refusals } from '../control/schema/refusals.ts';
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
    throw refusals.errors.NO_INFERENCE_CREATE_UNSUPPORTED({
      message: `No-inference create is unsupported: ${creation.reason}`,
    });
  if (
    input.delegation === undefined ||
    input.modelSelection?.provider !== 'claude' ||
    input.modelSelection.model === 'default'
  )
    throw refusals.errors.NO_INFERENCE_CREATE_REQUIREMENTS({
      message: 'No-inference create requires immutable delegation and an explicit provider/model',
    });
}
