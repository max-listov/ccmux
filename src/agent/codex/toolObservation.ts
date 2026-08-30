import { z } from 'zod';
import { observedToolName, type ToolObservation } from '../../content/toolSchema.ts';

const present = z.unknown().transform((value) => value !== undefined && value !== null);
export const CodexToolFieldsSchema = z.object({
  type: z.string(),
  status: z.string().nullable().optional(),
  tool: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  success: z.boolean().nullable().optional(),
  result: z.object({}).nullable().optional(),
  error: present.optional(),
  failure: present.optional(),
});
const toolTypes = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
  'collabAgentToolCall',
]);

/** Native outcome fields are evidence; item/completed alone only ends the observation lifecycle. */
export function codexToolObservation(
  item: z.infer<typeof CodexToolFieldsSchema> & { id: string },
  event?: 'started' | 'completed',
): ToolObservation | null {
  if (!toolTypes.has(item.type)) return null;
  const terminal =
    event === 'completed' ||
    ['completed', 'failed', 'interrupted', 'declined'].includes(item.status ?? '');
  const lifecycle = terminal
    ? 'completed'
    : event === 'started' || item.status === 'inProgress'
      ? 'running'
      : 'unknown';
  const exitCode = terminal && item.type === 'commandExecution' ? (item.exitCode ?? null) : null;
  let outcome: ToolObservation['outcome'] = 'unknown';
  if (terminal) {
    if (item.status === 'interrupted') outcome = 'interrupted';
    else if (item.status === 'declined') outcome = 'declined';
    else if (
      item.status === 'failed' ||
      item.error === true ||
      item.failure === true ||
      item.success === false
    )
      outcome = 'failed';
    else if (exitCode !== null) outcome = exitCode === 0 ? 'succeeded' : 'failed';
    else if (item.success === true) outcome = 'succeeded';
    else if (item.type === 'fileChange' && item.status === 'completed') outcome = 'succeeded';
    else if (item.type === 'mcpToolCall' && item.status === 'completed' && item.result != null)
      outcome = 'succeeded';
  }
  return {
    callId: item.id,
    name: observedToolName(item.tool ?? item.type),
    lifecycle,
    outcome,
    exitCode,
  };
}
