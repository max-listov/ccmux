import { freshestLimits, type ProfileView } from '../quota/view.ts';
import {
  type PlanLimits,
  planLimitsStaleAfterMs,
  planWindowExpired,
} from '../runtime/planLimits.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';
import type { FleetAccount, ProjectedPlanLimits } from './fleetSchema.ts';

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
  const groupOf = (account: NativeAccount): Group | null => {
    const label = account.label;
    if (!label) return null;
    // The provider is part of the identity, not decoration. One person signs into Claude and into
    // Codex with the same address, and grouping on the address alone merged two different plans
    // into one row — which then showed whichever was measured last as "the" limit. Two budgets,
    // two windows, two rows.
    const provider = account.provider ?? null;
    const key = `${provider ?? 'unknown'}\u0000${label}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        id: `${provider ?? 'unknown'}:${label}`,
        label,
        provider,
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
    if (view.account === null) continue;
    const group = groupOf(view.account);
    if (group === null) continue;
    group.candidates.push(view.limits);
    group.subscription ??= view.account.subscription ?? null;
    group.profiles.push({
      machine,
      profile: view.home ?? 'default',
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
