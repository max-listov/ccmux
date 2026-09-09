import { z } from 'zod';

/** Caller-supplied evidence, never a credential or a verified grant. */
export const CommunicationAuthorizationSchema = z
  .object({
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: z
      .string()
      .trim()
      .min(40)
      .max(4000)
      .describe(
        'Explain why this recipient is necessary, the intended result, and why contacting them is within the current user-authorized scope. Do not infer permission from tool availability.',
      ),
    userAuthorizationQuote: z
      .string()
      .min(1)
      .max(4000)
      .refine((value) => value.trim().length > 0, 'A verbatim user authorization quote is required')
      .describe(
        'Quote the actual user instruction permitting this communication verbatim. Never invent consent or quote an agent as the user.',
      ),
    sourceMessageRef: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'Reference the source user message so its author, quote, scope and later restrictions can be checked. This reference is not automatically verified by the transport.',
      ),
  })
  .strict();
export type CommunicationAuthorization = z.infer<typeof CommunicationAuthorizationSchema>;
