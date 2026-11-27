import { createHash } from 'node:crypto';
import * as executor from 'stitchkit/agent-executor';
import { codexPlanLimits as readCodexPlanLimits } from 'stitchkit/agent-executor/codex';
import type { PlanLimits, PlanWindow } from './planLimitsSchema.ts';
import type { RateLimitsReport } from './rateLimitsReport.ts';

/** How long a sample may stand before it is asked again, whichever runtime produced it. */
export const PLAN_LIMITS_MAX_AGE_MS = 5 * 60_000;

/**
 * How old a measurement may be before it is called stale.
 *
 * A native runtime is asked again every few minutes, so five minutes without an answer is a fault. A
 * status line only speaks while its session works, and a probe runs on a schedule of tens of
 * minutes, so for those the same age is simply the interval between measurements and calling it
 * stale would mark nearly every reading. Thirty minutes is past the longest scheduled gap.
 */
export function planLimitsStaleAfterMs(source: PlanLimits['source']): number {
  return source === 'native' ? PLAN_LIMITS_MAX_AGE_MS : 30 * 60_000;
}

/**
 * A window stops describing the present when its own interval ends — a clock event, not a spend.
 *
 * Both runtimes' refresh paths were written around the opposite belief, in the same words: "the
 * window only moves when a turn spends against it, so the end of a turn is the one moment the
 * answer can have changed". A reset moves it too, and so does a sibling session on the same
 * account. Measured: a five-hour window that reset at 06:29Z was still being served as 100 % full
 * at 08:05Z, while the runtime's own display said 36 %.
 */
export function planWindowExpired(window: PlanWindow, now: number): boolean {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}

/**
 * Whether a sample should be read again: it is old, or one of its windows has ended.
 *
 * `unpublished` is not due — the runtime does not report the fact, and asking again cannot change
 * that. `no-plan-limit` is not due either: a session with no plan window does not grow one.
 */
export function planLimitsDue(limits: PlanLimits | null | undefined, now: number): boolean {
  return executor.planLimitsDue({
    now: new Date(now),
    maxAgeMs: PLAN_LIMITS_MAX_AGE_MS,
    limits:
      limits == null
        ? undefined
        : {
            answer: limits.answer,
            observedAt: limits.observedAt,
            ...(limits.error === null ? {} : { error: limits.error }),
            windows: limits.windows.map((window) => ({
              name: window.key,
              usedPercent: window.percent,
              ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt }),
            })),
          },
  });
}

/** The same sample, carrying the reason its refresh failed. Never invents or clears a measurement. */
export function planLimitsReadFailed(
  limits: PlanLimits | null | undefined,
  now: number,
  reason: string,
): PlanLimits {
  const error = reason.slice(0, 160);
  return limits === null || limits === undefined
    ? { ...unpublishedPlanLimits(now), error }
    : { ...limits, error };
}

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

/** The percentage sampled by a passive status update. */
const readWindow = (
  key: string,
  used: number | undefined,
  resetsAt: number | null | undefined,
): PlanWindow | null => {
  const filled = percent(used);
  if (filled === null) return null;
  return {
    key: key.slice(0, 64),
    label: null,
    percent: filled,
    windowMinutes: null,
    resetsAt: iso(resetsAt),
    scope: null,
  };
};

/**
 * The plan windows a terminal Claude session's status line reported, in the shared vocabulary.
 *
 * Only what was reported is a window: a render that carried no `rate_limits` is not a statement
 * that the plan has none, so there is no `no-plan-limit` answer here — the caller passes null and
 * gets null, which the projection carries as "not measured". `observedAt` is the time of the render
 * that carried the windows, not of the latest render.
 */
export function statusLinePlanLimits(report: RateLimitsReport | null): PlanLimits | null {
  if (report === null) return null;
  const windows: PlanWindow[] = [];
  for (const [key, window] of [
    ['five_hour', report.fiveHour],
    ['seven_day', report.sevenDay],
  ] as const) {
    if (window === null) continue;
    const read = readWindow(key, window.pct, window.resetsAt);
    if (read !== null) windows.push(read);
  }
  if (windows.length === 0) return null;
  return {
    answer: 'known',
    plan: null,
    windows,
    observedAt: new Date(report.at).toISOString(),
    source: 'statusline',
    error: null,
  };
}

/** The runtime does not report plan limits at all — distinct from reporting that there are none. */
export function unpublishedPlanLimits(
  now: number,
  source: PlanLimits['source'] = 'native',
): PlanLimits {
  return {
    answer: 'unpublished',
    plan: null,
    windows: [],
    observedAt: new Date(now).toISOString(),
    source,
    error: null,
  };
}

/** Project the executor's measured answer into the on-disk CCMux format. */
export function projectExecutorPlanLimits(
  limits: executor.PlanLimits,
  source: PlanLimits['source'] = 'native',
): PlanLimits {
  const keys = new Set<string>();
  return {
    answer: limits.answer,
    observedAt: new Date(limits.observedAt).toISOString(),
    plan: limits.plan?.slice(0, 64) ?? null,
    error: limits.error?.slice(0, 160) ?? null,
    source,
    windows: limits.windows.map((window) => {
      // Existing CCMux readers and stored samples use model_scoped for Claude's named windows.
      const name =
        window.scope && window.name.startsWith('model:')
          ? `model_scoped:${window.name.slice(6)}`
          : window.name === 'model_scoped'
            ? 'model_scoped:unknown'
            : window.name;
      const key =
        name.length <= 64 && !keys.has(name) && window.name !== 'model:unknown'
          ? name
          : `${name.slice(0, 47)}-${createHash('sha256').update(window.name).digest('hex').slice(0, 16)}`;
      keys.add(key);
      return {
        key,
        label: window.label?.slice(0, 128) ?? null,
        scope: window.scope?.slice(0, 128) ?? null,
        percent: Math.round(window.usedPercent * 10) / 10,
        windowMinutes: window.windowDurationMins ?? null,
        resetsAt: iso(window.resetsAt),
      };
    }),
  };
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
  const window = readWindow(info.rateLimitType ?? 'unknown', info.utilization, info.resetsAt);
  if (!window) return current;
  const base = current ?? { answer: 'known' as const, plan: null, windows: [] };
  return {
    answer: 'known',
    plan: base.plan,
    windows: [...base.windows.filter((w) => w.key !== window.key), window].slice(0, 32),
    observedAt: new Date(now).toISOString(),
    source: 'native',
    error: null,
  };
}

/** Account RPC and rollout records share the executor's Codex reader. */
export function codexPlanLimits(
  reported: unknown,
  now: number,
  origin: PlanLimits['source'] = 'native',
): PlanLimits {
  return projectExecutorPlanLimits(readCodexPlanLimits(reported, new Date(now)), origin);
}

/**
 * How long the window is, when that is knowable at all.
 *
 * The declared duration wins over the name: Codex's `primary` was measured carrying a WEEK, so a
 * position tells nothing, and Claude's `five_hour` states its length only in the name. Null is a
 * window whose length neither source gives — printed as its own key rather than as a guess.
 */
export function planWindowMinutes(window: PlanWindow): number | null {
  return (
    executor.planWindowDurationMins({
      name: window.key,
      ...(window.windowMinutes === null ? {} : { windowDurationMins: window.windowMinutes }),
    }) ?? null
  );
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
  const failed = limits.error === null ? '' : ` · read failed: ${limits.error}`;
  if (limits.answer === 'no-plan-limit') return `no plan limit${failed}`;
  if (limits.answer === 'unpublished') return `limits unpublished${failed}`;
  if (limits.windows.length === 0) return `no windows reported${failed}`;
  // How old the reading is, said in words, once it is old enough for the difference to matter. A
  // percentage carries no date on it, and a bar drawn from a ninety-minute-old sample looks exactly
  // like one drawn a second ago.
  const age = now - Date.parse(limits.observedAt);
  const stale = age >= planLimitsStaleAfterMs(limits.source) ? `${ago(age, 'measured')} · ` : '';
  const via = limits.source === 'native' ? '' : ` (via ${limits.source})`;
  return (
    stale +
    [...limits.windows]
      .sort((a, b) => b.percent - a.percent)
      .map((window) => {
        // A window past its own reset says nothing about the interval running now. Printing its
        // last percentage would be answering a question about the present with a measurement of
        // the past — and the number it printed was 100 %, in red, for ninety minutes.
        if (planWindowExpired(window, now))
          return `${planWindowLabel(window)} ${ago(now - Date.parse(window.resetsAt ?? ''), 'window ended')}, not re-read`;
        const resets =
          window.resetsAt === null ? '' : ` ↻${humanizeUntil(Date.parse(window.resetsAt) - now)}`;
        return `${planWindowLabel(window)} ${Math.round(window.percent)}%${resets}`;
      })
      .join(' · ') +
    via +
    failed
  );
}

/** How long ago something happened, in words — with the degenerate case worded rather than
 *  arithmetic: `humanizeUntil` answers "now" for a zero duration, and "now ago" is not English. */
const ago = (ms: number, what: string): string => {
  const spoken = humanizeUntil(ms);
  return spoken === 'now' ? `${what} just now` : `${what} ${spoken} ago`;
};

/** A duration in words. Used both for "until" and for "ago", so it never carries a direction. */
const humanizeUntil = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24 === 0 ? '' : `${hours % 24}h`}`;
};
