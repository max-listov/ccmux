import { z } from 'zod';

/** Native-only input: paths are resolved from authorized owner storage, never from control callers. */
export const CodexTurnInputSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('text'), text: z.string(), text_elements: z.array(z.never()) })
    .strict(),
  z.object({ type: z.literal('localImage'), path: z.string().startsWith('/') }).strict(),
  z
    .object({ type: z.literal('skill'), name: z.string(), path: z.string().startsWith('/') })
    .strict(),
]);
export type CodexTurnInput = z.infer<typeof CodexTurnInputSchema>;
export function codexTextInput(text: string): CodexTurnInput[] {
  return text.length === 0 ? [] : [{ type: 'text', text, text_elements: [] }];
}
