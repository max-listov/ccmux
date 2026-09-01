import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { NativeUsage } from '../../../runtime/projectionSchema.ts';

/**
 * What the SDK reports about token spend, mapped without inventing anything.
 *
 * The SDK declares every count as a required number, so a reported `0` is a real zero and must be
 * kept as one. Absence exists at a coarser grain — a turn with no result message yet, or a model
 * missing from the per-model record — and that is the only place `null` may come from. The two
 * mistakes available here are opposite and both fatal to a reader: writing `0` for a count nobody
 * sent, and dropping a genuine `0` because it looks like absence. The reference implementation makes
 * the second one deliberately; this does neither.
 */

/**
 * The four counts this mapping consumes, taken from the SDK's own declaration.
 *
 * A structural restatement would keep compiling after the SDK renamed a field, and the first sign
 * would be usage silently reading zero on the fleet. Picking the fields off the real type makes that
 * a build error instead.
 */
export type SdkModelUsage = Pick<
  ModelUsage,
  'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
>;

/**
 * Counts are cumulative across turns in streaming-input mode.
 *
 * The per-model record grows for the life of the session, so a turn's own spend is the difference
 * against what the previous turn had already accounted for. Reporting the running total as the
 * turn's usage inflates every turn after the first, and the inflation compounds.
 */
export function turnDelta(
  current: Readonly<Record<string, SdkModelUsage>>,
  previous: Readonly<Record<string, SdkModelUsage>>,
): SdkModelUsage {
  const zero: SdkModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const sum = (record: Readonly<Record<string, SdkModelUsage>>): SdkModelUsage =>
    Object.values(record).reduce(
      (acc, model) => ({
        inputTokens: acc.inputTokens + model.inputTokens,
        outputTokens: acc.outputTokens + model.outputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + model.cacheReadInputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + model.cacheCreationInputTokens,
      }),
      zero,
    );
  const now = sum(current);
  const before = sum(previous);
  // A total that went DOWN is not a negative turn: a session-level reset (a cleared conversation, a
  // resumed session starting fresh) restarts the running count, and the honest reading of the first
  // turn after that is its own absolute spend, not a negative difference.
  const step = (a: number, b: number): number => (a >= b ? a - b : a);
  return {
    inputTokens: step(now.inputTokens, before.inputTokens),
    outputTokens: step(now.outputTokens, before.outputTokens),
    cacheReadInputTokens: step(now.cacheReadInputTokens, before.cacheReadInputTokens),
    cacheCreationInputTokens: step(now.cacheCreationInputTokens, before.cacheCreationInputTokens),
  };
}

/**
 * A turn's usage in this project's vocabulary.
 *
 * `reported: false` is how a caller says "no result message arrived" — a crashed or aborted turn,
 * whose zeroed counts are the absence of a measurement rather than a measurement of nothing.
 */
export function nativeUsage(input: {
  reported: boolean;
  delta?: SdkModelUsage;
}): NativeUsage | null {
  if (!input.reported || input.delta === undefined) return null;
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = input.delta;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cacheReadInputTokens + cacheCreationInputTokens,
    // The SDK has no counterpart. Its nearest value is documented as an ESTIMATE, and publishing an
    // estimate where every other runtime publishes a provider count would make the field mean two
    // different things depending on who filled it in.
    reasoningOutputTokens: null,
    // Not reported either. Summing input and output would look like a provider figure and would be
    // wrong wherever the provider counts something these two do not cover.
    totalTokens: null,
  };
}
