import { z } from 'zod';
import { observedToolName, type ToolObservation } from '../../content/toolSchema.ts';

export const OpenCodeToolFieldsSchema = z.object({
  tool: z.string().optional(),
  callID: z.string().min(1).max(256).optional(),
  state: z
    .object({
      status: z.enum(['pending', 'running', 'completed', 'error']),
      metadata: z
        .object({
          exit: z.number().int().nullable().optional(),
          interrupted: z.boolean().optional(),
          timeout: z.boolean().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

/** Classic tool state metadata supplies exit/interruption evidence without inspecting output text. */
export function openCodeToolObservation(
  part: z.infer<typeof OpenCodeToolFieldsSchema>,
): ToolObservation {
  const state = part.state;
  const lifecycle = state?.status === 'error' ? 'completed' : (state?.status ?? 'unknown');
  const terminal = lifecycle === 'completed';
  const exitCode = terminal && part.tool === 'bash' ? (state?.metadata?.exit ?? null) : null;
  let outcome: ToolObservation['outcome'] = 'unknown';
  if (terminal) {
    if (state?.metadata?.interrupted === true) outcome = 'interrupted';
    else if (
      state?.status === 'error' ||
      (part.tool === 'bash' && state?.metadata?.timeout === true)
    )
      outcome = 'failed';
    else if (exitCode !== null) outcome = exitCode === 0 ? 'succeeded' : 'failed';
  }
  return {
    callId: part.callID ?? null,
    name: observedToolName(part.tool),
    lifecycle,
    outcome,
    exitCode,
  };
}
