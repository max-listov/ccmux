import { z } from 'zod';

/**
 * What a model key may NOT contain, rather than what it may.
 *
 * Which keys exist is a property of the runtime: it publishes the catalog, and `validateTurnOptions`
 * already refuses any key that catalog does not list. A character allowlist here is a second and
 * staler authority beside that one, and it was wrong — the Claude runtime publishes `opus[1m]` and
 * the two `[1m]` Fable rows, and this field refused them before the catalog check ever ran. The
 * host offered a model its own admission then rejected as malformed input.
 *
 * The bound stays, and so does the refusal of whitespace and control bytes: no catalog key carries
 * either, and the value is copied into argv and into log lines where they would corrupt the record.
 * Provider is not the same case — that word is ours, written by the adapter, not reported.
 */
const printableKey = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
};

export const NativeModelSelectionSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    model: z
      .string()
      .min(1)
      .max(256)
      .refine(printableKey, 'Model key must not contain whitespace or control characters'),
  })
  .strict();

/**
 * How a refusal names the model it refused.
 *
 * A refusal that named only the field — "modelSelection.model is wrong or missing" — sent a
 * consumer looking for a malformed request twice, because nothing in it said which value was
 * rejected. The value is safe to say: it is the key the caller just sent and the catalog already
 * publishes. What stays unsaid is everything behind it — recipe, endpoint, credential — which this
 * echo never touches.
 */
export const modelSelectionLabel = (selection: { provider: string; model: string }): string =>
  `${selection.provider}/${selection.model}`;

export const NativeTurnOptionsSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('custom'), model: NativeModelSelectionSchema }).strict(),
  z
    .object({
      runtime: z.literal('claude'),
      model: NativeModelSelectionSchema,
      /**
       * How hard the model should think.
       *
       * A bounded string, not a fixed set of names: which levels exist is a property of the model,
       * the runtime reports it per model in the catalog, and `validateTurnOptions` refuses anything
       * the catalog does not list. A closed enum here would be a second, staler authority beside
       * that one — it would reject a level the runtime accepts until someone edited this line.
       *
       * The argument holds for every runtime that publishes its levels, so the codex branch below
       * is bounded the same way.
       */
      effort: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      runtime: z.literal('codex'),
      model: NativeModelSelectionSchema,
      mode: z.enum(['default', 'plan']),
      /** Bounded the same way, and for the same reason, as the branch above. */
      effort: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      runtime: z.literal('opencode'),
      model: NativeModelSelectionSchema,
      agent: z.string().min(1).max(128).optional(),
      variant: z.string().min(1).max(128).optional(),
    })
    .strict(),
]);
export type NativeModelSelection = z.infer<typeof NativeModelSelectionSchema>;
export type NativeTurnOptions = z.infer<typeof NativeTurnOptionsSchema>;
export const AcceptedTurnOptionsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    options: NativeTurnOptionsSchema,
  })
  .strict();
export type AcceptedTurnOptions = z.infer<typeof AcceptedTurnOptionsSchema>;
export const NativeSelectionEvidenceSchema = z
  .object({
    model: NativeModelSelectionSchema,
    options: NativeTurnOptionsSchema.nullable(),
    source: z.enum(['admission', 'settings', 'assistant', 'reroute']),
    turnId: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type NativeSelectionEvidence = z.infer<typeof NativeSelectionEvidenceSchema>;
