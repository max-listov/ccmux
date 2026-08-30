import { z } from 'zod';

export const ToolNameSchema = z.string().min(1).max(128);
export const ToolLifecycleSchema = z.enum(['pending', 'running', 'completed', 'unknown']);
export const ToolOutcomeSchema = z.enum([
  'unknown',
  'succeeded',
  'failed',
  'interrupted',
  'declined',
]);
export const ToolObservationSchema = z
  .object({
    callId: z.string().min(1).max(256).nullable(),
    name: ToolNameSchema.nullable(),
    lifecycle: ToolLifecycleSchema,
    outcome: ToolOutcomeSchema,
    exitCode: z.number().int().nullable(),
  })
  .strict()
  .refine(
    (tool) =>
      tool.lifecycle === 'completed' || (tool.outcome === 'unknown' && tool.exitCode === null),
    'Nonterminal tool observation cannot claim an outcome',
  );
export type ToolObservation = z.infer<typeof ToolObservationSchema>;

export function observedToolName(name: string | undefined): string | null {
  const parsed = ToolNameSchema.safeParse(name);
  return parsed.success ? parsed.data : null;
}

export function toolHistoryStatus(tool: ToolObservation): 'inProgress' | 'completed' | 'unknown' {
  return tool.lifecycle === 'pending' || tool.lifecycle === 'running'
    ? 'inProgress'
    : tool.lifecycle;
}
