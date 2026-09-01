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
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

const iso = (at: string | number | null | undefined): string | null => {
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  // Both providers send epoch numbers and neither says which unit. Seconds and milliseconds are
  // three orders of magnitude apart, so the boundary is unambiguous for any date this century.
  return new Date(at < 1e12 ? at * 1000 : at).toISOString();
};

const percent = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, Math.round(value * 10) / 10);
};

const label = (value: unknown, max = 128): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length === 0 ? null : text.slice(0, max);
};

/**
 * A window as either runtime writes one, read structurally rather than by a closed schema.
 *
 * The live Claude response carried buckets absent from the published types — `seven_day_cowork`,
 * `nimbus_quill`, and more — so a closed set would break on the server's next experiment. Known
 * windows are read by name; anything else shaped like a window is carried under its own key.
 */
const readWindow = (
  key: string,
  raw: unknown,
  extra?: { label?: string | null; scope?: string | null },
): PlanWindow | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const filled = percent(source.utilization ?? source.usedPercent ?? source.used_percent);
  if (filled === null) return null;
  const minutes = source.windowDurationMins ?? source.window_minutes ?? source.windowMinutes;
  return {
    key: key.slice(0, 64),
    label: extra?.label ?? null,
    percent: filled,
    windowMinutes:
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
        ? Math.round(minutes)
        : null,
    resetsAt: iso((source.resets_at ?? source.resetsAt) as string | number | null | undefined),
    scope: extra?.scope ?? null,
  };
};

/** The runtime does not report plan limits at all — distinct from reporting that there are none. */
export function unpublishedPlanLimits(now: number): PlanLimits {
  return {
    answer: 'unpublished',
    plan: null,
    windows: [],
    observedAt: new Date(now).toISOString(),
  };
}

/**
 * What Claude's usage read reports, mapped without narrowing the server's vocabulary.
 *
 * `rate_limits_available: false` is its own answer and the reason this cannot just count windows:
 * an API-key session reports no windows AND no limit, and a subscription session that has used
 * nothing reports windows at zero. Those are opposite facts with the same window count.
 */
export function claudePlanLimits(reported: unknown, now: number): PlanLimits {
  const observedAt = new Date(now).toISOString();
  if (reported === null || typeof reported !== 'object') return unpublishedPlanLimits(now);
  const source = reported as Record<string, unknown>;
  const plan = label(source.subscription_type, 64);
  if (source.rate_limits_available === false)
    return { answer: 'no-plan-limit', plan, windows: [], observedAt };
  const limits = source.rate_limits;
  if (limits === null || typeof limits !== 'object') return unpublishedPlanLimits(now);
  const windows: PlanWindow[] = [];
  for (const [key, raw] of Object.entries(limits as Record<string, unknown>)) {
    if (key === 'model_scoped') {
      for (const entry of Array.isArray(raw) ? raw : []) {
        const scope = label((entry as Record<string, unknown> | null)?.display_name);
        const window = readWindow(`model_scoped:${scope ?? 'unknown'}`, entry, {
          ...(scope === null ? {} : { label: scope, scope }),
        });
        if (window) windows.push(window);
      }
      continue;
    }
    // `limits` and `spend` are the same numbers in a second arrangement, and `extra_usage` is a
    // credit balance rather than a window. Carrying them would double-count what is already read.
    if (key === 'limits' || key === 'spend' || key === 'extra_usage') continue;
    const window = readWindow(key, raw);
    if (window) windows.push(window);
  }
  return { answer: 'known', plan, windows: windows.slice(0, 32), observedAt };
}

/**
 * One window pushed by a `rate_limit_event`, merged onto what a read already established.
 *
 * The event and the read answer different questions: the event fires WHEN the server says
 * something — including `rejected`, which is the refusal itself — while the read answers "how full
 * is it now". Merging keeps the other windows the read established rather than replacing the whole
 * picture with the single window the server happened to mention.
 */
export function mergeRateLimitEvent(
  current: PlanLimits | undefined,
  info: { rateLimitType?: string; utilization?: number; resetsAt?: number },
  now: number,
): PlanLimits | undefined {
  const window = readWindow(info.rateLimitType ?? 'unknown', info);
  if (!window) return current;
  const base = current ?? { answer: 'known' as const, plan: null, windows: [] };
  return {
    answer: 'known',
    plan: base.plan,
    windows: [...base.windows.filter((w) => w.key !== window.key), window].slice(0, 32),
    observedAt: new Date(now).toISOString(),
  };
}

/**
 * What Codex reports, from either place it writes it.
 *
 * `account/rateLimits/read` answers on demand in camelCase; the rollout's `token_count` carries the
 * same fact in snake_case after a turn. One reader for both, because a second one would drift.
 * `rateLimitsByLimitId` carries the per-model buckets, keyed by the id the server named them with.
 */
export function codexPlanLimits(reported: unknown, now: number): PlanLimits {
  const observedAt = new Date(now).toISOString();
  if (reported === null || typeof reported !== 'object') return unpublishedPlanLimits(now);
  const outer = reported as Record<string, unknown>;
  // The account read answers with an envelope — the main bucket beside a map of the per-model ones
  // — while the rollout writes the bucket alone. Unwrapping here rather than at each caller is what
  // keeps the per-model windows: reading the inner bucket and passing that on silently drops them.
  const inner = outer.rateLimits;
  const source: Record<string, unknown> =
    inner !== null && typeof inner === 'object'
      ? { ...(inner as Record<string, unknown>), rateLimitsByLimitId: outer.rateLimitsByLimitId }
      : outer;
  const primaryId = label(source.limitId ?? source.limit_id, 64);
  const plan = label(source.planType ?? source.plan_type, 64);
  const windows: PlanWindow[] = [];
  const push = (id: string | null, bucket: Record<string, unknown>): void => {
    const name = label(bucket.limitName ?? bucket.limit_name);
    for (const position of ['primary', 'secondary'] as const) {
      const key = id === null || id === primaryId ? position : `${id}:${position}`;
      const window = readWindow(key, bucket[position], {
        ...(name === null ? {} : { label: name }),
      });
      if (window) windows.push(window);
    }
  };
  push(primaryId, source);
  const byId = source.rateLimitsByLimitId ?? source.rate_limits_by_limit_id;
  if (byId !== null && typeof byId === 'object')
    for (const [id, bucket] of Object.entries(byId as Record<string, unknown>)) {
      if (id === primaryId || bucket === null || typeof bucket !== 'object') continue;
      push(id, bucket as Record<string, unknown>);
    }
  if (windows.length === 0) return unpublishedPlanLimits(now);
  return { answer: 'known', plan, windows: windows.slice(0, 32), observedAt };
}

/** Known window names, for the providers that name a window instead of stating its length. */
const NAMED_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
  seven_day_oauth_apps: 10_080,
  seven_day_overage_included: 10_080,
};

/**
 * How long the window is, when that is knowable at all.
 *
 * The declared duration wins over the name: Codex's `primary` was measured carrying a WEEK, so a
 * position tells nothing, and Claude's `five_hour` states its length only in the name. Null is a
 * window whose length neither source gives — printed as its own key rather than as a guess.
 */
export function planWindowMinutes(window: PlanWindow): number | null {
  return window.windowMinutes ?? NAMED_MINUTES[window.key] ?? null;
}

/**
 * What a person calls this window: `5h`, `7d`, `7d Fable`, or the name the provider gave it.
 *
 * The provider's raw key is the last resort rather than the basis. A window that names a model or
 * carries a limit name is recognised by that, and repeating the key beside it — `model scoped:Fable
 * Fable` — says one thing twice while reading as two.
 */
export function planWindowLabel(window: PlanWindow): string {
  const minutes = planWindowMinutes(window);
  const duration =
    minutes === null
      ? null
      : minutes % 1440 === 0
        ? `${minutes / 1440}d`
        : minutes % 60 === 0
          ? `${minutes / 60}h`
          : `${minutes}m`;
  const name = window.scope ?? window.label;
  if (duration !== null) return name === null ? duration : `${duration} ${name}`;
  return name ?? window.key.replace(/_/g, ' ');
}

/**
 * One line an operator can read, or the honest sentence when there is no number to give.
 *
 * Windows are ordered by how full they are, because the one about to stop the work is the one worth
 * reading first — not the one the provider happened to list first.
 */
export function formatPlanLimits(limits: PlanLimits | null, now: number): string {
  if (limits === null) return 'limits not read';
  if (limits.answer === 'no-plan-limit') return 'no plan limit';
  if (limits.answer === 'unpublished') return 'limits unpublished';
  if (limits.windows.length === 0) return 'no windows reported';
  return [...limits.windows]
    .sort((a, b) => b.percent - a.percent)
    .map((window) => {
      const resets =
        window.resetsAt === null ? '' : ` ↻${humanizeUntil(Date.parse(window.resetsAt) - now)}`;
      return `${planWindowLabel(window)} ${Math.round(window.percent)}%${resets}`;
    })
    .join(' · ');
}

const humanizeUntil = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24 === 0 ? '' : `${hours % 24}h`}`;
};
