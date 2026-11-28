import { z } from 'zod';
import type { PlanLimits, PlanWindow } from '../runtime/planLimitsSchema.ts';

/**
 * What `agy -p "/usage" --output-format json` prints, read into Stitchmux's unified plan windows.
 *
 * The `/usage` slash command is handled locally by `agy` without running a model turn
 * (`num_turns: 0`, `command.name: "usage"`). Any answer that ran a turn or executed another command
 * is refused fail-closed so an unexpected prompt response can never be stored as quota data.
 *
 * Sign convention: `agy` reports `remaining_fraction` (fraction LEFT, 0..1), whereas Stitchmux's
 * `PlanWindow.percent` is percentage USED (0..100). An unstarted window reports epoch zero
 * (`1970-01-01T00:00:00Z`), which is normalized to `resetsAt: null` so staleness checks do not
 * mistake it for a decades-expired reset. Disabled buckets (such as an inactive 5h sub-window when
 * its parent weekly bucket is already exhausted) are omitted.
 */

const AntigravityBucketSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number().finite().min(0).max(1),
  reset_time: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
});

const AntigravityGroupSchema = z.object({
  name: z.string(),
  buckets: z.array(AntigravityBucketSchema),
});

const AntigravityUsageJsonSchema = z.object({
  status: z.string(),
  num_turns: z.number().int(),
  command: z
    .object({
      name: z.string(),
      data: z
        .object({
          groups: z.array(AntigravityGroupSchema),
        })
        .optional(),
    })
    .optional(),
});

export type AntigravityUsageParse = { ok: true; limits: PlanLimits } | { ok: false; error: string };

function windowDurationMinutes(window: string | undefined): number | null {
  switch (window) {
    case 'weekly':
      return 10_080;
    case '5h':
      return 300;
    default:
      return null;
  }
}

function normalizeResetTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Date.parse(trimmed);
  // Antigravity emits Unix epoch zero (`1970-01-01T00:00:00Z`) for unstarted windows.
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

export function parseAntigravityUsage(text: string, now: number): AntigravityUsageParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const first = text.trim().split('\n')[0]?.slice(0, 120) ?? '';
    return {
      ok: false,
      error: first
        ? `agy /usage returned invalid JSON: ${first}`
        : 'agy /usage returned empty output',
    };
  }
  const parsed = AntigravityUsageJsonSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'agy /usage response did not match the expected JSON shape' };
  }
  const data = parsed.data;
  if (data.status !== 'SUCCESS') {
    return { ok: false, error: `agy /usage status was ${data.status.slice(0, 64)}` };
  }
  if (data.num_turns !== 0) {
    return { ok: false, error: `agy /usage executed ${data.num_turns} model turn(s)` };
  }
  if (data.command?.name !== 'usage' || data.command.data === undefined) {
    return { ok: false, error: 'agy /usage did not return local usage command data' };
  }

  const windows: PlanWindow[] = [];
  for (const group of data.command.data.groups) {
    const scope = group.name.trim() === '' ? null : group.name.trim().slice(0, 128);
    for (const bucket of group.buckets) {
      if (bucket.disabled === true) continue;
      const usedPercent = Math.min(
        100,
        Math.max(0, Math.round((1 - bucket.remaining_fraction) * 1000) / 10),
      );
      const label = bucket.name?.trim() ? bucket.name.trim().slice(0, 128) : null;
      windows.push({
        key: bucket.id.slice(0, 64),
        label,
        percent: usedPercent,
        windowMinutes: windowDurationMinutes(bucket.window),
        resetsAt: normalizeResetTime(bucket.reset_time),
        scope,
      });
    }
  }

  if (windows.length === 0) {
    return { ok: false, error: 'agy /usage reported no active quota windows' };
  }

  return {
    ok: true,
    limits: {
      answer: 'known',
      plan: null,
      windows: windows.slice(0, 32),
      observedAt: new Date(now).toISOString(),
      source: 'probe',
      error: null,
    },
  };
}

const APPLY_AUTH_RE = /applyAuthResult:\s*email=([^\s,;]+)(?:,\s*authMethod=([^\s,;]+))?/;
const OAUTH_SUCCESS_RE = /OAuth:\s*authenticated successfully as\s+([^\s,;]+)/;

/**
 * Extract the authenticated account email and auth method emitted by `agy` into a dedicated
 * `--log-file` during our own `/usage` probe. Never reads or parses any credential/token value.
 */
export function parseAntigravityLogIdentity(logText: string): {
  email: string | null;
  authMethod: string | null;
} {
  let email: string | null = null;
  let authMethod: string | null = null;
  for (const line of logText.split('\n')) {
    const applied = APPLY_AUTH_RE.exec(line);
    if (applied?.[1]) {
      email = applied[1].trim().slice(0, 256);
      if (applied[2]) authMethod = applied[2].trim().slice(0, 64);
      continue;
    }
    const authed = OAUTH_SUCCESS_RE.exec(line);
    if (authed?.[1]) {
      email = authed[1].trim().slice(0, 256);
    }
  }
  return { email: email === '' ? null : email, authMethod: authMethod === '' ? null : authMethod };
}
