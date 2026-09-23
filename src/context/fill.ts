import type { ContextInfo } from '../types.ts';

// Context-fill label parsing, shared by provider pane-scrapers. The "<used>/<limit> <pct>%"
// shape is common to the agent statuslines we read; a provider that renders differently
// can still feed its own label through here.

const UNIT: Record<string, number> = { k: 1e3, m: 1e6, g: 1e9 };

/** "850.0k" → 850000, "1.0M" → 1000000, "1200" → 1200; null on an unparseable label. */
export function tokNum(label: string): number | null {
  const mm = label.match(/^([\d.]+)([kKmMgG])?$/);
  const digits = mm?.[1];
  if (digits === undefined) return null;
  const n = Number.parseFloat(digits);
  if (Number.isNaN(n)) return null;
  const unit = mm?.[2];
  const mult = unit ? (UNIT[unit.toLowerCase()] ?? 1) : 1;
  return Math.round(n * mult);
}

/**
 * Parse a context label ("120k/1.0M 12%" | "40k" | null) into structured tokens.
 *
 * Which ceiling the label was measured against is left null on every path, and that is the honest
 * answer rather than a gap: a status line prints one number and never says whether a compaction
 * policy narrowed it. Filling in `model-limit` here would state something this source cannot know.
 */
export function parseContext(ctx: string | null): ContextInfo {
  const unmeasured = { rawLimitTokens: null, window: null } as const;
  if (!ctx)
    return { text: null, usedTokens: null, limitTokens: null, percent: null, ...unmeasured };
  const [pair, pct] = ctx.split(' ');
  if (pair?.includes('/')) {
    const [used, limit] = pair.split('/');
    return {
      text: ctx,
      usedTokens: tokNum(used ?? ''),
      limitTokens: tokNum(limit ?? ''),
      percent: pct ? Number.parseInt(pct, 10) : null,
      ...unmeasured,
    };
  }
  return { text: ctx, usedTokens: tokNum(ctx), limitTokens: null, percent: null, ...unmeasured };
}
