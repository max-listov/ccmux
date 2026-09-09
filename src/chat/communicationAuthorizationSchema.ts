import { z } from 'zod';

/**
 * WHICH fact the sender is standing on. The three differ in what can be checked, which is the whole
 * reason they are named rather than left to prose.
 *
 * `user-instruction` is the sender quoting its own user; nothing about it is verifiable here, and the
 * trust boundary says so. `peer-letter` is the case a permission actually arrives in: the user gives
 * a pair leave to correspond and says it to ONE of them, so the other has no such line in its own
 * conversation and can only quote a neighbour — which is unfalsifiable prose. Referenced as a
 * ccmux record instead, it becomes the one basis this transport can genuinely check: both ends hold
 * the letter, and the recipient's own ledger says who wrote it and to whom. `thread-continuation`
 * carries no rationale at all, on purpose — a permission belongs to the correspondence, and a field
 * that must be re-typed for every letter is filled ritually within a month and then means nothing.
 */
export const CommunicationBasisSchema = z.enum([
  'user-instruction',
  'peer-letter',
  'thread-continuation',
]);
export type CommunicationBasis = z.infer<typeof CommunicationBasisSchema>;

/**
 * `<peer thread uuid>#<message uuid>` — both ids are already printed on every delivered chat line
 * (`[chat from ccmux/<agent>@<machine>:<session>#<thread> · id: <message>]`), so the sender copies
 * a reference rather than composing one. The thread is always the PEER's: the neighbour who wrote
 * the letter, or the recipient whose correspondence is being continued.
 */
export function parseLedgerMessageRef(ref: string): { threadId: string; messageId: string } | null {
  const parts = ref.trim().split('#');
  if (parts.length !== 2) return null;
  const parsed = z.object({ threadId: z.uuid(), messageId: z.uuid() }).safeParse({
    threadId: parts[0],
    messageId: parts[1],
  });
  return parsed.success ? parsed.data : null;
}

/** Caller-supplied evidence, never a credential or a verified grant. */
export const CommunicationAuthorizationSchema = z
  .object({
    // Optional in the record, required of a new sender by `requireOriginatingBasis`. Records written
    // before the basis was named carry the `user-instruction` SHAPE and no claim about which basis
    // it was; reading absence as a stated basis would invent the fact this field exists to record.
    basis: CommunicationBasisSchema.optional().describe(
      'Which fact authorizes this message: the user instruction you hold, a peer letter that carried the permission, or an authorization already established in this correspondence.',
    ),
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope: z
      .string()
      .trim()
      .min(40)
      .max(4000)
      .optional()
      .describe(
        'Explain why this recipient is necessary, the intended result, and why contacting them is within the current user-authorized scope. Do not infer permission from tool availability. Omitted only by a thread continuation, which repeats nothing.',
      ),
    userAuthorizationQuote: z
      .string()
      .min(1)
      .max(4000)
      .refine((value) => value.trim().length > 0, 'A verbatim user authorization quote is required')
      .optional()
      .describe(
        'Quote the actual user instruction permitting this communication verbatim — as the user said it, or as the peer letter reported it. Never invent consent, and never present an agent’s own words as the user’s. Omitted only by a thread continuation.',
      ),
    sourceMessageRef: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'Where the authorization lives: the source user message for `user-instruction`, or `<peer thread uuid>#<message uuid>` for `peer-letter` and `thread-continuation`. A ccmux reference is resolved against this machine’s own records; a prose reference is not automatically verified by the transport.',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const named = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (value.basis === 'thread-continuation') {
      // Forbidden, not merely unnecessary: allowed-but-optional is how the ritual comes back, and a
      // re-typed rationale is exactly what stops being read.
      if (value.whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope !== undefined)
        named(
          'whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope',
          'A thread continuation repeats no rationale: the authorization it points at holds it',
        );
      if (value.userAuthorizationQuote !== undefined)
        named(
          'userAuthorizationQuote',
          'A thread continuation repeats no quote: the authorization it points at holds it',
        );
    } else {
      if (value.whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope === undefined)
        named(
          'whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope',
          'Required: why this recipient, what result, and under which user-authorized scope',
        );
      if (value.userAuthorizationQuote === undefined)
        named('userAuthorizationQuote', 'Required: the user authorization, quoted verbatim');
    }
    if (
      (value.basis === 'peer-letter' || value.basis === 'thread-continuation') &&
      parseLedgerMessageRef(value.sourceMessageRef) === null
    )
      named(
        'sourceMessageRef',
        'This basis references a ccmux record: <peer thread uuid>#<message uuid>, both copied from the chat line',
      );
  });
export type CommunicationAuthorization = z.infer<typeof CommunicationAuthorizationSchema>;

/** New requests must name their basis; stored observations without that fact stay unchanged. */
export const CommunicationAuthorizationInputSchema = CommunicationAuthorizationSchema.safeExtend({
  basis: CommunicationBasisSchema,
});
export type CommunicationAuthorizationInput = z.infer<typeof CommunicationAuthorizationInputSchema>;
