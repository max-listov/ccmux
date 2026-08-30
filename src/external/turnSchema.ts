import { z } from 'zod';

/** Receipt timestamps describe a short-lived observation, never the start time of a turn. */
export const ExternalTurnStateSchema = z
  .object({
    state: z.enum(['working', 'idle', 'waiting-approval', 'waiting-input', 'unknown']),
    evidence: z.enum(['observed', 'unknown', 'unavailable', 'stale']),
    source: z.enum(['codex-app-server', 'unsupported']),
    observedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    reason: z.enum([
      'native-status',
      'not-loaded',
      'system-error',
      'unsupported-status',
      'unsupported-provider',
      'unsupported-runtime',
      'not-observed',
      'not-reported',
      'read-limit',
      'connection-unavailable',
      'deadline',
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.state !== 'unknown') !== (value.evidence === 'observed')) {
      ctx.addIssue({
        code: 'custom',
        message: 'only observed native evidence may claim a turn state',
      });
    }
    if (
      value.evidence === 'observed' &&
      (value.observedAt === null || value.expiresAt === null || value.source !== 'codex-app-server')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'observed turn state requires native provenance and freshness',
      });
    }
  });

export type ExternalTurnState = z.infer<typeof ExternalTurnStateSchema>;

export function unknownTurnState(
  source: ExternalTurnState['source'],
  reason: ExternalTurnState['reason'] = 'not-observed',
  evidence: ExternalTurnState['evidence'] = 'unknown',
): ExternalTurnState {
  return { state: 'unknown', evidence, source, observedAt: null, expiresAt: null, reason };
}
