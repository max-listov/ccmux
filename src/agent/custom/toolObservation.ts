import { z } from 'zod';
import type { ToolObservation } from '../../content/toolSchema.ts';

const ExitSchema = z.object({ exitCode: z.number().int() });
export function customToolObservation(
  name: string,
  callId: string,
  outcome: ToolObservation['outcome'],
  output: unknown,
): ToolObservation {
  const exitCode =
    name === 'run_command' ? (ExitSchema.safeParse(output).data?.exitCode ?? null) : null;
  return {
    name: name.slice(0, 128),
    callId,
    lifecycle: outcome === 'unknown' ? 'running' : 'completed',
    outcome: outcome === 'succeeded' && exitCode !== null && exitCode !== 0 ? 'failed' : outcome,
    exitCode: outcome === 'unknown' ? null : exitCode,
  };
}
