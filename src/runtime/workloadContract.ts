import { z } from 'zod';

export const FiniteWorkloadsSchema = z.strictObject({
  launcherBin: z.string().startsWith('/'),
  profileFile: z.string().startsWith('/'),
});
export type FiniteWorkloads = z.infer<typeof FiniteWorkloadsSchema>;

// Installed process protocol: payload bytes are never decoded as the control outcome.
export const WorkloadOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    schema: z.literal('node-workload-result/v1'),
    status: z.literal('completed'),
    admissionId: z.uuid(),
    exitCode: z.int().min(0).max(255).nullable(),
    signal: z.string().nullable(),
    reason: z.string().nullable(),
    failures: z
      .array(
        z.strictObject({
          source: z.enum(['payload', 'monitor']),
          message: z.string(),
          detail: z.string(),
        }),
      )
      .optional(),
  }),
  z.strictObject({
    schema: z.literal('node-workload-result/v1'),
    status: z.literal('refused'),
    reason: z.string().min(1),
    detail: z.string(),
  }),
  z.strictObject({
    schema: z.literal('node-workload-result/v1'),
    status: z.literal('failed'),
    reason: z.string().min(1),
    detail: z.string(),
  }),
]);
export type WorkloadOutcome = z.infer<typeof WorkloadOutcomeSchema>;

/** What `<launcher> --describe` prints: the protocol this adapter speaks. */
export const WorkloadProtocolSchema = z.looseObject({
  schema: z.literal('node-workload-protocol/v1'),
  command: z.literal('node-workload-run'),
  platform: z.literal('linux'),
  mode: z.literal('disposable'),
  supervisor: z.literal('direct-parent-process-instance'),
});

/**
 * The launcher's own exit code for an outcome, protocol v1: refused 125, failed 126, completed the
 * payload's code — and a payload that ended by a signal has no code, which the launcher reports as 1.
 * A different exit means the result file and the process disagree, so neither is trusted.
 */
export function launcherExitCode(outcome: WorkloadOutcome): number {
  if (outcome.status === 'refused') return 125;
  if (outcome.status === 'failed') return 126;
  return outcome.exitCode ?? 1;
}

/**
 * Cancellation is SIGTERM, which the launcher answers by taking the payload tree down. A launcher
 * that does not finish within this grace is killed outright: a bounded cancel that leaves cleanup to
 * the launcher's own supervisor beats a cancel that never returns.
 */
export const WORKLOAD_CANCEL_GRACE_MS = 5_000;
/** Stale request directories older than any workload's deadline plus grace are swept at start. */
export const WORKLOAD_DIRECTORY_PREFIX = 'ccmux-finite-';
