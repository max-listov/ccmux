import { STATE_DIR } from '../config/paths.ts';
import { type PlanLimits, planWindowExpired } from '../runtime/planLimits.ts';
import type { MachineConfig, Session } from '../types.ts';
import { withLock } from '../util/lock.ts';
import { log } from '../util/log.ts';
import { discoverTargets, type QuotaTarget } from './discover.ts';
import { type ProbeOutcome, probe } from './probe.ts';
import { type QuotaRecord, readQuotaRecord, writeQuotaRecord } from './store.ts';
import { profileViews } from './view.ts';

/**
 * Keep every profile's quota current, asking the vendor's program only when nothing fresher says.
 *
 * A probe is not free — the Claude program scans its local sessions to answer, measured at 4 to 12
 * seconds of CPU — so the rule is to ask the least that keeps every account honest: not when a
 * status line or an earlier probe measured it within `refreshMinutes`, not before a failure's
 * back-off has passed, and never two at once. A measured window that has since reset is the one
 * thing that makes an answer stale before its time, so it brings the next probe forward.
 */

const MINUTE = 60_000;
/** A probe takes up to 90 s; a second asker waits for it rather than asking the same program twice. */
const PROBE_LOCK_WAIT_MS = 120_000;

/** First retry after a failed attempt; doubled for each further failure up to the ceiling. */
const BACKOFF_FIRST_MS = 5 * MINUTE;
const BACKOFF_MAX_MS = 60 * MINUTE;

export type RefreshOutcome =
  | { key: string; action: 'probed'; ok: true }
  | { key: string; action: 'probed'; ok: false; error: string }
  | { key: string; action: 'skipped'; why: 'off' | 'fresh' | 'backing-off' };

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

/** Whether a measurement is too old to stand, or describes a window that has since ended. */
export function measurementDue(limits: PlanLimits | null, now: number, refreshMs: number): boolean {
  if (limits === null) return true;
  const age = now - Date.parse(limits.observedAt);
  if (age >= refreshMs) return true;
  // An answer that carries no windows (billed by the token, a runtime that publishes none) cannot
  // go stale by a reset; it is asked again by age like any other, not every pass.
  return (
    limits.answer === 'known' &&
    age >= MINUTE &&
    limits.windows.some((window) => planWindowExpired(window, now))
  );
}

function nextRecord(
  target: QuotaTarget,
  previous: QuotaRecord | null,
  outcome: ProbeOutcome,
  now: number,
): QuotaRecord {
  const attemptedAt = new Date(now).toISOString();
  if (outcome.ok)
    return {
      key: target.key,
      provider: target.provider,
      label: outcome.label,
      plan: outcome.plan,
      accountProvider: outcome.provider,
      limits: outcome.limits,
      error: null,
      attemptedAt,
      failures: 0,
    };
  // The last good answer stays, with its own age; only the reason it was not refreshed is new.
  return {
    key: target.key,
    provider: target.provider,
    label: previous?.label ?? null,
    plan: previous?.plan ?? null,
    accountProvider: previous?.accountProvider ?? null,
    limits: previous?.limits ?? null,
    error: outcome.error,
    attemptedAt,
    failures: (previous?.failures ?? 0) + 1,
  };
}

export async function refreshQuota(
  m: MachineConfig,
  sessions: readonly Session[],
  opts: {
    force?: boolean;
    now?: number;
    ask?: typeof probe;
    signal?: AbortSignal;
    /** Also look in the home folder for profiles no session names. On by default. */
    scan?: boolean;
  } = {},
): Promise<RefreshOutcome[]> {
  const ask = opts.ask ?? probe;
  const refreshMs = m.quota.refreshMinutes * MINUTE;
  const scan = opts.scan ?? true;
  const views = new Map(profileViews(m, sessions, { scan }).map((view) => [view.key, view]));
  const out: RefreshOutcome[] = [];
  for (const target of discoverTargets(m, sessions, { scan })) {
    opts.signal?.throwIfAborted();
    const now = opts.now ?? Date.now();
    if (opts.force !== true && m.quota.probe === 'off') {
      out.push({ key: target.key, action: 'skipped', why: 'off' });
      continue;
    }
    const record = readQuotaRecord(target.key);
    const view = views.get(target.key);
    // A profile that now holds a different login than its record was taken for is asked at once:
    // neither a back-off earned by the previous account nor a fresh status line settles it.
    const identityChanged = view?.identityChanged ?? false;
    if (opts.force !== true && !identityChanged && record !== null && record.failures > 0) {
      const wait = backoffMs(record.failures);
      if (now - Date.parse(record.attemptedAt) < wait) {
        out.push({ key: target.key, action: 'skipped', why: 'backing-off' });
        continue;
      }
    }
    if (
      opts.force !== true &&
      !identityChanged &&
      !measurementDue(view?.limits ?? null, now, refreshMs)
    ) {
      out.push({ key: target.key, action: 'skipped', why: 'fresh' });
      continue;
    }
    const run = async (): Promise<RefreshOutcome> => {
      // Another process (the daemon, a `ccmux accounts --refresh`) may have asked while this one
      // waited for the lock; its answer is read before deciding to ask again.
      const current = readQuotaRecord(target.key);
      if (
        opts.force !== true &&
        current !== null &&
        current.attemptedAt !== record?.attemptedAt &&
        !identityChanged
      )
        return { key: target.key, action: 'skipped', why: 'fresh' };
      const outcome = await ask(m, target, opts.signal);
      await writeQuotaRecord(nextRecord(target, current, outcome, Date.now()));
      if (outcome.ok) return { key: target.key, action: 'probed', ok: true };
      log.warn({ msg: 'quota probe failed', profile: target.key, error: outcome.error });
      return { key: target.key, action: 'probed', ok: false, error: outcome.error };
    };
    out.push(
      await withLock(
        `${STATE_DIR}/quota/${target.key.replace(/[^\w.-]/g, '_')}.lock`,
        run,
        'quota probe',
        PROBE_LOCK_WAIT_MS,
        opts.signal,
      ),
    );
  }
  return out;
}
