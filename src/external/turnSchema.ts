import { z } from 'zod';

/**
 * The ways the control endpoint itself fails — one list, because two places need it and a second
 * copy would drift: the turn state a consumer reads, and the snapshot reason the resident observer
 * publishes. Each has a different answer for a person, which is the whole point of keeping them
 * apart; the last is the honest fallback for a failure this build cannot name.
 */
export const CONNECTION_REASONS = [
  'endpoint-absent',
  'endpoint-not-listening',
  'upgrade-refused',
  'connection-lost',
  'connection-unavailable',
] as const;
export type ConnectionReason = (typeof CONNECTION_REASONS)[number];

/** Receipt timestamps describe a short-lived observation, never the start time of a turn. */
export const ExternalTurnStateSchema = z
  .object({
    state: z.enum(['working', 'idle', 'waiting-approval', 'waiting-input', 'unknown']),
    evidence: z.enum(['observed', 'unknown', 'unavailable', 'stale']),
    source: z.enum(['codex-app-server', 'unsupported']),
    turnId: z.string().min(1).max(128).nullable(),
    startedAt: z.iso.datetime().nullable(),
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
      // Collapsed into one name these were unactionable: fifty threads read `connection-unavailable`
      // while the app was open and being typed into, and the name described the wire rather than
      // anything to do about it.
      ...CONNECTION_REASONS,
      'deadline',
    ]),
    // What a PERSON can do about it, or null when there is nothing for them to do. A reason names
    // the state; only this names the cure, and a consumer showing an outage has nothing else to
    // print. Null is not "unknown": it says this state resolves without anyone acting.
    remedy: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.startedAt !== null && value.turnId === null) ||
      ((value.state === 'unknown' || value.state === 'idle') &&
        (value.turnId !== null || value.startedAt !== null))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'native turn metadata belongs to an observed active turn',
      });
    }
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

/** One table, so the reason and its cure cannot drift apart into two sources of truth. */
export function remedyFor(reason: ExternalTurnState['reason']): string | null {
  switch (reason) {
    case 'endpoint-absent':
      return 'Start the Codex app, or enable its app server, so the control endpoint exists here.';
    case 'endpoint-not-listening':
      return 'The control endpoint exists but nothing accepts on it — its app server exited. Restart the Codex app.';
    case 'upgrade-refused':
      return 'Something answers on the control endpoint but refuses the RPC upgrade — check which app owns it.';
    case 'connection-lost':
      return 'The control connection dropped mid-read; the next observation reconnects. Restart the Codex app if it keeps dropping.';
    case 'connection-unavailable':
      return 'The control endpoint failed in a way this build cannot name — connect to it by hand to see the operating system error.';
    case 'unsupported-runtime':
      return 'This Codex version does not report thread status. Update the app.';
    default:
      return null;
  }
}

export function unknownTurnState(
  source: ExternalTurnState['source'],
  reason: ExternalTurnState['reason'] = 'not-observed',
  evidence: ExternalTurnState['evidence'] = 'unknown',
): ExternalTurnState {
  return {
    state: 'unknown',
    evidence,
    source,
    turnId: null,
    startedAt: null,
    observedAt: null,
    expiresAt: null,
    reason,
    remedy: remedyFor(reason),
  };
}
