import type { ToolSet } from 'ai';
import { z } from 'zod';

const MountedFailureSchema = z.object({
  name: z.literal('AgentToolError'),
  output: z.object({ error: z.string() }),
  cause: z.object({ code: z.string().optional() }).optional(),
});

export type ToolObservation =
  | { kind: 'returned'; value: unknown }
  | { kind: 'rejected'; mounted: boolean; code: string; causeCode?: string };

/** Observe the actual Promise channel; successful business data may contain an error field. */
export async function invoke(
  tools: ToolSet,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolObservation> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`Missing published tool: ${name}`);
  try {
    const value = await execute(input, {
      toolCallId: crypto.randomUUID(),
      messages: [],
      context: undefined,
      ...(signal === undefined ? {} : { abortSignal: signal }),
    });
    return { kind: 'returned', value };
  } catch (error) {
    const parsed = MountedFailureSchema.safeParse(error);
    return {
      kind: 'rejected',
      mounted: parsed.success,
      code: parsed.data?.output.error ?? 'unexpected-rejection',
      ...(parsed.data?.cause?.code && { causeCode: parsed.data.cause.code }),
    };
  }
}

export function refused(
  result: ToolObservation,
): result is Extract<ToolObservation, { kind: 'rejected' }> {
  return result.kind === 'rejected' && result.mounted;
}

export function output(result: ToolObservation) {
  return result.kind === 'returned' ? result.value : undefined;
}
