import { type AccountMachine, type AccountProfileInput, fleetAccounts } from '../fleet/accounts.ts';
import { formatPlanLimits } from '../runtime/planLimits.ts';

/** The accounts of a fleet as lines a person reads; the grouping is `fleet/accounts.ts`. */
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
