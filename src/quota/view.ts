import { profileAccount } from '../agent/claude/account.ts';
import { claudeProfile } from '../agent/claude/profileRoot.ts';
import {
  type PlanLimits,
  planLimitsStaleAfterMs,
  planWindowExpired,
  statusLinePlanLimits,
} from '../runtime/planLimits.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';
import { readMetricsFile } from '../session/metricsFile.ts';
import type { MachineConfig, Session } from '../types.ts';
import { HOME } from '../util/env.ts';
import { discoverTargets, type QuotaTarget } from './discover.ts';
import { type QuotaRecord, readQuotaRecord } from './store.ts';

/**
 * What this machine knows about each profile's account and quota, from every source at once.
 *
 * The same account is measured by up to three different things — the status line of any of its
 * terminal sessions, a probe of the vendor's program, and a native session's own runtime — and they
 * age differently, so none of them is "the" answer. The newest known measurement wins and says what
 * it was (`source`), and a measurement that is only an absence — a runtime that does not publish, a
 * failed attempt — never hides an older one that is real.
 */

export interface ProfileView {
  key: string;
  provider: 'claude' | 'codex';
  /** Who is signed in; null until something has said. */
  account: NativeAccount | null;
  limits: PlanLimits | null;
  /** Why the newest probe attempt failed, if it did. */
  error: string | null;
  attemptedAt: string | null;
  /** The profile's directory; null for the default profile. */
  home: string | null;
  /** This machine's registered sessions under the profile. */
  sessions: string[];
  /** The profile now holds a different login than its stored probe record was taken for. */
  identityChanged: boolean;
}

const age = (limits: PlanLimits): number => Date.parse(limits.observedAt);

/** On a tie in time the runtime's own answer, then the status line, then a probe: the more direct
 *  the source, the more it is trusted — a rule, so the same inputs never answer two ways. */
const SOURCE_RANK: Record<PlanLimits['source'], number> = { native: 0, statusline: 1, probe: 2 };

/**
 * The newest answer that actually carries a measurement; failing that, the newest of any.
 *
 * The windows the newest source does not report are filled from the next-newest source that does,
 * while that reading is still within its own staleness age of the newest one and its window has not
 * ended. The sources do not report the same set — a status line has only the five-hour and weekly
 * windows, `/usage` adds the per-model ones, a native runtime adds buckets neither prints — and the
 * account's answer should not lose a window because a source that never carried it was newer. The
 * answer keeps the newest source's `source` and time: those describe the measurement that decided
 * the numbers they sit beside, and the carried windows are older readings of other windows.
 */
export function freshestLimits(
  ...candidates: (PlanLimits | null | undefined)[]
): PlanLimits | null {
  const present = candidates.filter((c): c is PlanLimits => c !== null && c !== undefined);
  const known = present.filter((c) => c.answer === 'known');
  const pool = (known.length > 0 ? known : present).sort(
    (a, b) => age(b) - age(a) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source],
  );
  const best = pool[0];
  if (best === undefined || best.answer !== 'known') return best ?? null;
  const at = age(best);
  const windows = [...best.windows];
  for (const other of pool.slice(1)) {
    if (at - age(other) > planLimitsStaleAfterMs(other.source)) continue;
    for (const window of other.windows) {
      if (windows.some((w) => w.key === window.key) || planWindowExpired(window, at)) continue;
      windows.push(window);
    }
  }
  return windows.length === best.windows.length ? best : { ...best, windows: windows.slice(0, 32) };
}

/** The status-line windows of any session under the profile that is signed in on the profile's own
 *  login — a session on an API key or a cloud provider says nothing about this account. */
function statuslineLimits(
  target: QuotaTarget,
  byName: ReadonlyMap<string, Session>,
  m: MachineConfig,
): PlanLimits | null {
  if (target.provider !== 'claude') return null;
  let best: PlanLimits | null = null;
  for (const name of target.sessions) {
    const session = byName.get(name);
    if (session === undefined || claudeProfile(session, m).ownCredentials) continue;
    const limits = statusLinePlanLimits(readMetricsFile(name)?.rateLimits ?? null);
    if (limits !== null && (best === null || age(limits) > age(best))) best = limits;
  }
  return best;
}

function viewOf(
  target: QuotaTarget,
  stored: QuotaRecord | null,
  byName: ReadonlyMap<string, Session>,
  m: MachineConfig,
): ProfileView {
  // The login the profile holds NOW. A record belongs to the account that was signed in when it was
  // taken: if the profile has been signed in as someone else since, the record describes another
  // account and is not used — and the profile is due a fresh probe, whatever a status line says.
  let current: NativeAccount | null = null;
  if (target.provider === 'claude') {
    const profile = claudeProfile(
      { dir: HOME, ...(target.envFile === null ? {} : { envFile: target.envFile }) },
      m,
    );
    const file = target.home === null ? profile.globalConfigFile : `${target.home}/.claude.json`;
    current = profileAccount(file);
  }
  const identityChanged =
    stored !== null &&
    stored.label !== null &&
    current?.label !== undefined &&
    current.label !== null &&
    current.label !== stored.label;
  const record = identityChanged ? null : stored;
  const live = statuslineLimits(target, byName, m);
  const measured = freshestLimits(record?.limits, live);
  // A status line does not name the plan; the probe did, so carry its word onto the newer numbers.
  const limits =
    measured !== null && measured.plan === null && record?.plan
      ? { ...measured, plan: record.plan }
      : measured;
  const account: NativeAccount | null =
    record !== null && record.label !== null
      ? {
          label: record.label,
          organization: null,
          subscription: null,
          provider: record.accountProvider,
        }
      : current;
  return {
    key: target.key,
    provider: target.provider,
    account,
    limits,
    error: record?.error ?? null,
    attemptedAt: record?.attemptedAt ?? null,
    home: target.home,
    sessions: target.sessions,
    identityChanged,
  };
}

/**
 * Every profile with its merged answer. `scan` adds the profiles nobody has a session for (see
 * `discoverTargets`); without it the answer is what the registered sessions already name, cheap
 * enough to compute for every list or fleet read.
 */
export function profileViews(
  m: MachineConfig,
  sessions: readonly Session[],
  opts: { scan?: boolean } = {},
): ProfileView[] {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  return discoverTargets(m, sessions, { scan: opts.scan ?? false }).map((target) =>
    viewOf(target, readQuotaRecord(target.key), byName, m),
  );
}

/**
 * Session name → the view of the profile it runs under. A session on its own credentials is left
 * out: it is not signed in as the profile's account, so the profile's account and windows are not
 * its own.
 */
export function viewsBySession(
  views: readonly ProfileView[],
  sessions: readonly Session[],
  m: MachineConfig,
): Map<string, ProfileView> {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  const out = new Map<string, ProfileView>();
  for (const view of views)
    for (const name of view.sessions) {
      const session = byName.get(name);
      if (session === undefined) continue;
      if (session.agent === 'claude' && claudeProfile(session, m).ownCredentials) continue;
      out.set(name, view);
    }
  return out;
}

/** The profiles of this machine, in the shape the fleet grouping takes. */
export function machineProfiles(
  m: MachineConfig,
  sessions: readonly Session[],
): { machine: string; view: ProfileView }[] {
  return profileViews(m, sessions, { scan: true }).map((view) => ({ machine: m.rcPrefix, view }));
}
