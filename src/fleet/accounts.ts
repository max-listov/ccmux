import { freshestLimits, type ProfileView } from '../quota/view.ts';
import { planLimitsStaleAfterMs, planWindowExpired } from '../runtime/planLimits.ts';
import type { PlanLimits } from '../runtime/planLimitsSchema.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';
import type { FleetAccount, FleetMachine, ProjectedPlanLimits } from './fleetSchema.ts';

function projectLimits(limits: PlanLimits | null, now: number): ProjectedPlanLimits | null {
  if (limits === null) return null;
  return {
    ...limits,
    stale: now - Date.parse(limits.observedAt) >= planLimitsStaleAfterMs(limits.source),
    windows: limits.windows.map((window) => ({
      ...window,
      expired: planWindowExpired(window, now),
    })),
  };
}

/** The fields the grouping reads from a session, whether it came from this machine or a peer. */
export interface AccountSession {
  name: string;
  account: NativeAccount | null;
  costUsd: number | null;
  planLimits?: PlanLimits | null;
}

/** A machine as the grouping sees it: a label and its sessions. */
export interface AccountMachine {
  machine: string;
  sessions: readonly AccountSession[];
}

/** A profile of one machine, as the quota layer knows it — including a profile nobody has a session
 *  for, which no session row could ever carry. */
export interface AccountProfileInput {
  machine: string;
  view: ProfileView;
}

/** Combine local machine profiles with remote peers' reported profiles so 0-session remote
 *  accounts (Claude, Codex, Antigravity) appear in `accounts` and `fleet`. */
export function fleetMachineProfiles(
  machines: readonly Pick<FleetMachine, 'machine' | 'alias' | 'ok' | 'profiles'>[],
  local: readonly AccountProfileInput[],
): AccountProfileInput[] {
  const out: AccountProfileInput[] = [...local];
  const localMachines = new Set(local.map((entry) => entry.machine));
  for (const fm of machines) {
    if (!fm.ok || fm.alias === null || localMachines.has(fm.machine)) continue;
    for (const profile of fm.profiles ?? []) {
      out.push({
        machine: fm.machine,
        view: {
          key: profile.key,
          provider: profile.provider,
          account: profile.account,
          limits: profile.limits,
          error: profile.error,
          attemptedAt: profile.attemptedAt,
          home: profile.home,
          sessions: profile.sessions,
          identityChanged: false,
        },
      });
    }
  }
  return out;
}

export function fleetAccounts(
  machines: readonly AccountMachine[],
  now = Date.now(),
  profiles: readonly AccountProfileInput[] = [],
): FleetAccount[] {
  type Group = Omit<FleetAccount, 'limits' | 'costUsd'> & {
    costUsd: number | null;
    costed: boolean;
    candidates: (PlanLimits | null)[];
  };
  const groups = new Map<string, Group>();
  const ensureGroup = (key: string, init: Pick<Group, 'id' | 'label' | 'provider'>): Group => {
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        ...init,
        plan: null,
        subscription: null,
        costUsd: null,
        costed: false,
        sessions: [],
        profiles: [],
        candidates: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  const groupOf = (account: NativeAccount): Group | null => {
    const label = account.label;
    if (!label) return null;
    // The provider is part of the identity, not decoration. One person signs into Claude and into
    // Codex with the same address, and grouping on the address alone merged two different plans
    // into one row — which then showed whichever was measured last as "the" limit. Two budgets,
    // two windows, two rows.
    const provider = account.provider ?? null;
    const key = `${provider ?? 'unknown'}\u0000${label}`;
    return ensureGroup(key, { id: `${provider ?? 'unknown'}:${label}`, label, provider });
  };
  for (const fm of machines)
    for (const session of fm.sessions) {
      if (!session.account) continue;
      const group = groupOf(session.account);
      if (group === null) continue;
      group.sessions.push(`${fm.machine}:${session.name}`);
      if (session.costUsd !== null) {
        group.costUsd = (group.costUsd ?? 0) + session.costUsd;
        group.costed = true;
      }
      group.candidates.push(session.planLimits ?? null);
      group.subscription ??= session.account.subscription ?? null;
    }
  for (const { machine, view } of profiles) {
    const profileLabel = view.home ?? 'default';
    let group: Group | null = null;
    if (view.account !== null) {
      group = groupOf(view.account);
    } else if (view.limits !== null) {
      // A profile whose limits were measured without an email stays distinct per machine+profile
      // so two machines' unnamed profiles are never silently merged into one account.
      const key = `unlabelled\u0000${view.provider}\u0000${machine}\u0000${profileLabel}`;
      group = ensureGroup(key, {
        id: `${view.provider}:${machine}:${profileLabel}`,
        label: `${machine}:${profileLabel}`,
        provider: view.provider,
      });
    }
    if (group === null) continue;
    group.candidates.push(view.limits);
    group.subscription ??= view.account?.subscription ?? null;
    group.profiles.push({
      machine,
      profile: profileLabel,
      sessions: view.sessions.length,
      error: view.error,
      attemptedAt: view.attemptedAt,
    });
  }
  return [...groups.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ candidates, costed, ...group }) => {
      const limits = freshestLimits(...candidates);
      return {
        ...group,
        plan: limits?.plan ?? null,
        costUsd: costed ? group.costUsd : null,
        limits: projectLimits(limits, now),
      };
    });
}
