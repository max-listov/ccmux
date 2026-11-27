import { z } from 'zod';

/**
 * How much of a subscription plan a runtime says has been used, in one vocabulary.
 *
 * The two runtimes disagree about everything except the percentage. Claude names its windows
 * (`five_hour`, `seven_day`) and leaves the duration implied; Codex numbers them (`primary`,
 * `secondary`) and states the duration explicitly — and a measured `primary` turned out to be the
 * WEEKLY window, so rendering position as duration would have been an invention. So a window here
 * carries its provider's own key AND the duration when the provider declares one; neither is
 * derived from the other.
 *
 * The limit belongs to the ACCOUNT, not to the session that happened to ask. Ten sessions on one
 * account share one window, and ten identical bars beside them is a wrong model rather than a
 * cosmetic issue — which is why the projection travels next to the account label a reader groups on.
 */
export const PlanWindowSchema = z
  .object({
    /** The provider's own name for the window. Never translated: a rename would be a claim. */
    key: z.string().min(1).max(64),
    /** A human label when the provider supplies one (a limit's name, a model's display name). */
    label: z.string().min(1).max(128).nullable(),
    percent: z.number().min(0).max(100),
    /** Declared duration. Null when the provider only names the window and never states it. */
    windowMinutes: z.number().int().positive().nullable(),
    resetsAt: z.iso.datetime().nullable(),
    /** The model this window is scoped to, when it is scoped to one. */
    scope: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type PlanWindow = z.infer<typeof PlanWindowSchema>;

/**
 * Three answers, kept apart because collapsing any two of them lies to an operator.
 *
 * `known` carries windows. `no-plan-limit` is a session that has no plan window at all — an API
 * key, Bedrock, Vertex — and is not "nothing used yet". `unpublished` is a runtime that does not
 * report the fact, which is not "no limit". A zero would read as an empty window in all three.
 */
export const PlanLimitsSchema = z
  .object({
    answer: z.enum(['known', 'no-plan-limit', 'unpublished']),
    plan: z.string().min(1).max(64).nullable(),
    windows: z.array(PlanWindowSchema).max(32),
    observedAt: z.iso.datetime(),
    /**
     * Where the numbers came from, because the same account is measured three ways and they do not
     * age alike. `native` is the runtime's own session answering for its account; `statusline` is
     * the status line of a terminal session (only sent after the session's first model response);
     * `probe` is a one-shot call of the vendor's own CLI for an account that has no fresher answer.
     * Defaulted, because records written before this field existed were all `native`.
     */
    source: z.enum(['native', 'statusline', 'probe']).default('native'),
    /**
     * Why the last attempt to refresh this sample did not replace it.
     *
     * A failed read leaves the previous measurement standing, which is right — a zero would be a
     * claim nobody made. But standing silently makes "nobody has spent since" and "we have not been
     * able to ask" the same picture, and they call for opposite reactions. Null is a sample that
     * was refreshed the last time it was asked. Defaulted, because records written before this
     * field existed carry no attempt at all.
     */
    error: z.string().max(160).nullable().default(null),
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
