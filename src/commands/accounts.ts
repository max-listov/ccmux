import { freshestLimits, type ProfileView } from '../quota/view.ts';
import {
  formatPlanLimits,
  type PlanLimits,
  type PlanWindow,
  planLimitsStaleAfterMs,
  planWindowExpired,
} from '../runtime/planLimits.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';

/**
 * The limits as a RESPONSE carries them: the stored sample plus what is only true at read time.
 *
 * `expired` and `stale` are computed when the answer is serialized and never stored, because a
 * stored one is wrong the moment the clock moves past it. They exist so a consumer does not have to
 * derive them: every consumer doing that arithmetic separately is how one of them ends up drawing a
 * ninety-minute-old 100 % as the present, which is exactly what happened.
 */
export interface ProjectedPlanLimits extends Omit<PlanLimits, 'windows'> {
  /** The sample is older than a sample is allowed to be. */
  stale: boolean;
  windows: (PlanWindow & { expired: boolean })[];
}

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

/** Where one account is signed in, and how the last attempt to ask the vendor about it went. */
export interface AccountProfile {
  machine: string;
  /** `default`, or the profile's directory. */
  profile: string;
  /** How many of that machine's sessions run under it. */
  sessions: number;
  /** Why the newest probe failed; null when it did not. */
  error: string | null;
  attemptedAt: string | null;
}

/**
 * Who is spending on what, across every machine, with how much of each plan is left.
 *
 * A limit belongs to an ACCOUNT, not to a session or a machine: ten sessions on one plan share one
 * window, and drawing ten identical bars beside them would be a wrong model rather than a
 * duplicated one. So the grouping IS the answer, and it is computed once here — the printed lines
 * and the JSON slice both read it, because two implementations of "which sessions share a plan"
 * would eventually disagree about the same fleet.
 */
export interface FleetAccount {
  /** `<provider>:<label>`: the identity the grouping used, stable across reads. */
  id: string;
  label: string;
  /** How the account is served (`firstParty`, `chatgpt`), when a session or a probe named it. */
  provider: string | null;
  /** The vendor's own word for the plan (`max`, `pro`), from the freshest measurement. Null when no
   *  source names one — it is never filled in from a guess or from a price list. */
  plan: string | null;
  /** The display name of the plan when a source gives one (`Claude Max`); a different fact from
   *  `plan`, so neither is derived from the other. */
  subscription: string | null;
  /** Total across the sessions that reported one. Null = nobody measured, which is not zero. */
  costUsd: number | null;
  /** Full addresses, so a reader copies one into `ccmux msg` without reconstructing it. */
  sessions: string[];
  /** Every profile the account is signed in under, with the state of its newest probe. */
  profiles: AccountProfile[];
  /**
   * The freshest measurement any source carries for the account.
   *
   * Freshest rather than merged: two sources on one account describe the SAME windows, so a merge
   * would combine two readings of one fact and could show a window that has since reset beside one
   * that has not. Null means nothing has measured this account yet.
   */
  limits: ProjectedPlanLimits | null;
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

export function accountLines(
  machines: readonly AccountMachine[],
  now = Date.now(),
  profiles: readonly AccountProfileInput[] = [],
): string[] {
  const accounts = fleetAccounts(machines, now, profiles);
  if (accounts.length === 0) return [];
  return [
    'accounts',
    ...accounts.flatMap((account) => {
      // A total nobody reported is written as unknown, never as zero: zero is a claim that the
      // sessions cost nothing, which is a different statement from having no measurement.
      const cost = account.costUsd === null ? 'cost unknown' : `$${account.costUsd.toFixed(2)}`;
      // The provider is printed beside the label for the same reason it keys the group: the two
      // rows would otherwise be one address twice, with no way to tell which plan is which.
      const who =
        account.provider === null ? account.label : `${account.label} (${account.provider})`;
      const named = account.subscription ?? account.plan;
      const plan = named === null ? '' : ` [${named}]`;
      const sessions = account.sessions.length === 0 ? 'no sessions' : account.sessions.join(' ');
      const failed = account.profiles.find((profile) => profile.error !== null);
      return [
        `  ${who}${plan}  ${cost}  ${sessions}`,
        `    plan ${formatPlanLimits(account.limits, now)}`,
        ...(failed === undefined ? [] : [`    probe failed: ${failed.error}`]),
      ];
    }),
  ];
}
