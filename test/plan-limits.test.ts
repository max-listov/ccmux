import { expect, test } from 'bun:test';
import {
  claudePlanLimits,
  codexPlanLimits,
  formatPlanLimits,
  mergePlanLimits,
  mergeRateLimitEvent,
  planWindowLabel,
} from '../src/runtime/planLimits.ts';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');

/**
 * Both fixtures are the shapes the live runtimes actually returned, reduced but never rearranged —
 * including the buckets the published types do not declare, which is the point of two of these.
 */
const CLAUDE_LIVE = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 77, resets_at: '2026-09-01T14:59:59.848235+00:00' },
    seven_day: { utilization: 63, resets_at: '2026-09-07T09:59:59.848257+00:00' },
    seven_day_opus: null,
    // Server buckets absent from the package types. A closed schema would fail on the next one.
    nimbus_quill: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, used_credits: null },
    limits: [{ kind: 'session', percent: 77 }],
    model_scoped: [
      { display_name: 'Fable', utilization: 49, resets_at: '2026-09-07T09:59:59.848435+00:00' },
    ],
  },
};

const CODEX_LIVE = {
  limitId: 'codex',
  limitName: null,
  // Measured: the FIRST window is the weekly one. Position is not duration.
  primary: { usedPercent: 91, windowDurationMins: 10_080, resetsAt: 1_788_747_930 },
  secondary: null,
  planType: 'pro',
  rateLimitsByLimitId: {
    codex_model: {
      limitId: 'codex_model',
      limitName: 'A scoped model',
      primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1_788_277_655 },
      secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_788_864_455 },
    },
  },
};

test('a Claude read carries the windows it named and the ones it invented', () => {
  const limits = claudePlanLimits(CLAUDE_LIVE, NOW);
  expect(limits.answer).toBe('known');
  expect(limits.plan).toBe('max');
  const keys = limits.windows.map((window) => window.key);
  expect(keys).toContain('five_hour');
  expect(keys).toContain('seven_day');
  // Unknown to this build, carried under the server's own name rather than dropped or renamed.
  expect(keys).toContain('nimbus_quill');
  // Credit balances and the same numbers in a second arrangement are not windows.
  expect(keys).not.toContain('extra_usage');
  expect(keys).not.toContain('limits');
  const scoped = limits.windows.find((window) => window.scope === 'Fable');
  expect(scoped?.percent).toBe(49);
});

test('no plan limit is its own answer, never an empty window list', () => {
  // An API-key session reports no windows AND no limit; a fresh subscription reports windows at
  // zero. Both have nothing to draw, and they are opposite facts.
  const limits = claudePlanLimits(
    { subscription_type: null, rate_limits_available: false, rate_limits: null },
    NOW,
  );
  expect(limits.answer).toBe('no-plan-limit');
  expect(formatPlanLimits(limits, NOW)).toBe('no plan limit');
  // A build whose runtime does not publish the fact says so, and says something different.
  expect(formatPlanLimits(claudePlanLimits(undefined, NOW), NOW)).toBe('limits unpublished');
  expect(formatPlanLimits(null, NOW)).toBe('limits not read');
});

test('a Codex read states the duration, and the position never implies one', () => {
  const limits = codexPlanLimits(CODEX_LIVE, NOW);
  expect(limits.plan).toBe('pro');
  const primary = limits.windows.find((window) => window.key === 'codex:10080m');
  expect(primary?.percent).toBe(91);
  // 10080 minutes is a week. Rendering `primary` as "5h" would have been an invention.
  expect(planWindowLabel(primary as never)).toBe('7d');
  // Per-model buckets keep the id the server named them with, so two accounts never collide.
  expect(limits.windows.map((window) => window.key)).toContain('codex_model:300m');
  expect(limits.windows.find((window) => window.key === 'codex_model:10080m')?.percent).toBe(3);
});

test('the account read answers with an envelope, and its per-model windows are not dropped', () => {
  // What the live `account/rateLimits/read` returns: the main bucket beside a map of the scoped
  // ones. Passing the inner bucket on lost every per-model window without failing anything.
  const envelope = {
    rateLimits: { limitId: 'codex', primary: CODEX_LIVE.primary },
    rateLimitsByLimitId: CODEX_LIVE.rateLimitsByLimitId,
  };
  const keys = codexPlanLimits(envelope, NOW).windows.map((window) => window.key);
  expect(keys).toContain('codex:10080m');
  expect(keys).toContain('codex_model:300m');
});

test('the same reader takes the rollout spelling, because two readers would drift', () => {
  const rollout = {
    limit_id: 'codex',
    primary: { used_percent: 89, window_minutes: 10_080, resets_at: 1_788_747_930 },
  };
  expect(codexPlanLimits(rollout, NOW).windows[0]?.percent).toBe(89);
});

test('a pushed event updates one window and leaves the rest of the read standing', () => {
  const read = claudePlanLimits(CLAUDE_LIVE, NOW);
  const merged = mergeRateLimitEvent(
    read,
    { rateLimitType: 'five_hour', utilization: 94, resetsAt: 1_788_760_000 },
    NOW + 60_000,
  );
  expect(merged?.windows.find((window) => window.key === 'five_hour')?.percent).toBe(94);
  // The event named one window; the others are still the only measurement anybody has.
  expect(merged?.windows.find((window) => window.key === 'seven_day')?.percent).toBe(63);
  // An event on a session nobody had read yet is still an answer, not a discarded diagnostic.
  const alone = mergeRateLimitEvent(
    undefined,
    { rateLimitType: 'seven_day', utilization: 12 },
    NOW,
  );
  expect(alone?.answer).toBe('known');
  expect(alone?.windows).toHaveLength(1);
});

test('a window named by its model is read by that name, not by the key beside it', () => {
  const [scoped] = claudePlanLimits(CLAUDE_LIVE, NOW).windows.filter((w) => w.scope === 'Fable');
  // `model scoped:Fable Fable` said one thing twice and read as two windows.
  expect(planWindowLabel(scoped as never)).toBe('Fable');
  // Codex names a per-model bucket instead of scoping it; the name is used the same way.
  const codex = codexPlanLimits(CODEX_LIVE, NOW).windows.find((w) => w.key === 'codex_model:300m');
  expect(planWindowLabel(codex as never)).toBe('5h A scoped model');
});

test('the fullest window is read first, because it is the one that stops the work', () => {
  const line = formatPlanLimits(claudePlanLimits(CLAUDE_LIVE, NOW), NOW);
  expect(line.startsWith('5h 77%')).toBe(true);
  expect(line).toContain('↻5h');
  expect(line).toContain('7d 63%');
});

test('a pushed update carries one limit and must not erase the ones it is silent about', () => {
  // Measured live: after a model-scoped turn, Codex pushed only that model's windows. Replacing the
  // set with the push made the account-wide week — the one at 91% — simply disappear.
  const read = codexPlanLimits(CODEX_LIVE, NOW);
  const pushed = codexPlanLimits(
    {
      limitId: 'codex_model',
      limitName: 'A scoped model',
      primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_788_277_655 },
    },
    NOW + 60_000,
  );
  const merged = mergePlanLimits(read, pushed);
  expect(merged.windows.find((window) => window.key === 'codex:10080m')?.percent).toBe(91);
  expect(merged.windows.find((window) => window.key === 'codex_model:300m')?.percent).toBe(7);
});
