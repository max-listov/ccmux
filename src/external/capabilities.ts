import type { ExternalCapabilities, WriterRuntime } from '../types.ts';

export function externalCapabilities(
  storage: 'stored' | 'missing' | 'unknown',
  evidence: 'observed' | 'none-observed' | 'unknown',
  runtime: WriterRuntime | null,
): ExternalCapabilities {
  const inspect = storage === 'stored';
  const attemptAdopt = storage === 'stored' && evidence !== 'observed';
  const fork = storage === 'stored';
  const terminateAndAdopt =
    storage === 'stored' && evidence === 'observed' && runtime?.kind === 'dedicated-cli';
  const releaseAtSource = evidence === 'observed';
  const reasons: string[] = [];
  if (!inspect)
    reasons.push(
      storage === 'unknown'
        ? 'storage could not be inspected'
        : 'no persisted transcript is available yet',
    );
  if (evidence === 'unknown') reasons.push('writer ownership could not be verified');
  if (evidence === 'observed' && !terminateAndAdopt) {
    reasons.push('the live writer is shared, managed, self-owned, or has unknown ancestry');
  }
  if (evidence === 'none-observed') {
    reasons.push('no writer was observed; adoption must still revalidate atomically');
  }
  return { inspect, attemptAdopt, fork, terminateAndAdopt, releaseAtSource, reasons };
}
