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
    exitCode: z.number().int().min(0).max(255).nullable(),
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
