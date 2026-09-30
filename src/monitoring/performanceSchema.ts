import { z } from 'zod';

const CpuSchema = z
  .object({ userUs: z.number().nonnegative(), systemUs: z.number().nonnegative() })
  .strict();
export const DaemonPerformanceSchema = z
  .object({
    basis: z.literal('exclusive-operation-windows-and-sync-spans'),
    enabled: z.boolean(),
    since: z.iso.datetime(),
    elapsedMs: z.number().nonnegative(),
    cpu: CpuSchema,
    unattributed: CpuSchema,
    producers: z.record(z.string(), z.record(z.string(), z.number().nonnegative())),
    scopes: z
      .array(
        z
          .object({
            name: z.string().max(128),
            runs: z.number().int().nonnegative(),
            failures: z.number().int().nonnegative(),
            active: z.number().int().nonnegative(),
            durationMs: z.number().nonnegative(),
            cpu: CpuSchema.nullable(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export type PerformanceScope = z.infer<typeof DaemonPerformanceSchema>['scopes'][number];
