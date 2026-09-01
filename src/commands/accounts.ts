import { formatPlanLimits, type PlanLimits } from '../runtime/planLimits.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';

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
  label: string;
  /** The runtime family the account belongs to, when a session named one. */
  provider: string | null;
  plan: string | null;
  /** Total across the sessions that reported one. Null = nobody measured, which is not zero. */
  costUsd: number | null;
  /** Full addresses, so a reader copies one into `ccmux msg` without reconstructing it. */
  sessions: string[];
  /**
   * The newest limit observation any of those sessions carries.
   *
   * Newest rather than merged: two sessions on one account describe the SAME windows, so a merge
   * would combine two readings of one fact and could show a window that has since reset beside one
   * that has not. Null means no session on this account has ever been asked.
   */
  limits: PlanLimits | null;
}

export function fleetAccounts(machines: readonly AccountMachine[]): FleetAccount[] {
  const groups = new Map<string, FleetAccount & { costed: boolean }>();
  for (const fm of machines)
    for (const session of fm.sessions) {
      const label = session.account?.label;
      if (!label) continue;
      const group = groups.get(label) ?? {
        label,
        provider: session.account?.provider ?? null,
        plan: session.account?.subscription ?? null,
        costUsd: null,
        sessions: [],
        limits: null,
        costed: false,
      };
      group.sessions.push(`${fm.machine}:${session.name}`);
      if (session.costUsd !== null) {
        group.costUsd = (group.costUsd ?? 0) + session.costUsd;
        group.costed = true;
      }
      const limits = session.planLimits ?? null;
      if (limits !== null && (group.limits === null || limits.observedAt > group.limits.observedAt))
        group.limits = limits;
      group.plan ??= limits?.plan ?? null;
      groups.set(label, group);
    }
  return [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ costed, ...account }) => ({ ...account, costUsd: costed ? account.costUsd : null }));
}

export function accountLines(machines: readonly AccountMachine[], now = Date.now()): string[] {
  const accounts = fleetAccounts(machines);
  if (accounts.length === 0) return [];
  return [
    'accounts',
    ...accounts.flatMap((account) => {
      // A total nobody reported is written as unknown, never as zero: zero is a claim that the
      // sessions cost nothing, which is a different statement from having no measurement.
      const cost = account.costUsd === null ? 'cost unknown' : `$${account.costUsd.toFixed(2)}`;
      const plan = account.plan === null ? '' : ` [${account.plan}]`;
      return [
        `  ${account.label}${plan}  ${cost}  ${account.sessions.join(' ')}`,
        `    plan ${formatPlanLimits(account.limits, now)}`,
      ];
    }),
  ];
}
