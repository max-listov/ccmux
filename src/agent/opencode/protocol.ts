import { z } from 'zod';

const Id = z.string().min(1).max(256);
export const OpenCodeSessionSchema = z.object({
  id: Id.regex(/^ses_/),
  directory: z.string(),
  version: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  model: z.object({ id: Id, providerID: Id }).optional(),
});
export const OpenCodeStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('busy') }),
  z.object({ type: z.literal('retry'), attempt: z.number(), next: z.number() }),
]);
export const OpenCodeMessageSchema = z.object({
  id: Id,
  sessionID: Id,
  role: z.enum(['user', 'assistant']),
  parentID: Id.optional(),
  summary: z.union([z.boolean(), z.object({}).strip()]).optional(),
  providerID: Id.optional(),
  modelID: Id.optional(),
  finish: z.string().optional(),
  time: z.object({ created: z.number(), completed: z.number().optional() }),
  error: z.object({ name: z.string(), data: z.unknown() }).optional(),
  tokens: z
    .object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({ read: z.number(), write: z.number() }),
    })
    .optional(),
});
export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;
export const OpenCodePartSchema = z.object({
  id: Id,
  sessionID: Id,
  messageID: Id,
  type: z.string(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  tool: z.string().optional(),
  callID: Id.optional(),
  time: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
  state: z
    .object({
      status: z.enum(['pending', 'running', 'completed', 'error']),
      input: z.record(z.string(), z.unknown()).optional(),
      output: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;
export const OpenCodeDeltaSchema = z.object({
  sessionID: Id,
  messageID: Id,
  partID: Id,
  field: z.string(),
  delta: z.string(),
});
export const OpenCodePermissionSchema = z.object({
  id: Id,
  sessionID: Id,
  permission: z.string().max(256),
  tool: z.object({ messageID: Id, callID: Id }).optional(),
});
export const OpenCodeQuestionSchema = z.object({
  id: Id,
  sessionID: Id,
  questions: z
    .array(
      z.object({
        header: z.string().max(256),
        question: z.string().max(2_048),
        custom: z.boolean().optional(),
        multiple: z.boolean().optional(),
        options: z
          .array(z.object({ label: z.string().max(256), description: z.string().max(1_024) }))
          .max(32),
      }),
    )
    .min(1)
    .max(3),
  tool: z.object({ messageID: Id, callID: Id }).optional(),
});
export const OpenCodeEventSchema = z.object({ type: z.string(), properties: z.unknown() });

/** A tool step is not a turn. Transport EOF and session idle are not assistant completion. */
export function openCodeTerminal(
  message: OpenCodeMessage,
): 'completed' | 'failed' | 'interrupted' | null {
  if (message.role !== 'assistant') return null;
  if (message.error !== undefined)
    return message.error.name === 'MessageAbortedError' ? 'interrupted' : 'failed';
  if (
    message.time.completed === undefined ||
    !message.finish ||
    ['tool-calls', 'unknown'].includes(message.finish)
  )
    return null;
  return 'completed';
}
