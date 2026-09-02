import { expect, test } from 'bun:test';
import { accountIsEmpty, nativeAccount } from '../src/agent/claude/native/account.ts';
import { accountLines, fleetAccounts } from '../src/commands/fleetList.ts';
import type { PlanLimits } from '../src/runtime/planLimits.ts';

/**
 * Which session is spending whose account.
 *
 * A limit belongs to an account, not to a machine, so the grouping spans the whole fleet — and what
 * is NOT carried matters as much as what is: nothing here may become a step toward a credential.
 */

test('an account is an identity, and never says where a credential lives', () => {
  const account = nativeAccount({
    email: 'agent@example.test',
    organization: 'Example Org',
    subscriptionType: 'team',
    apiProvider: 'firstParty',
    // Fields naming where a credential comes from are deliberately not read.
  } as never);
  expect(account.label).toBe('agent@example.test');
  expect(account.subscription).toBe('team');
  expect(Object.keys(account).sort()).toEqual([
    'label',
    'organization',
    'provider',
    'subscription',
  ]);
});

test('an account with no email is labelled by its organization, never invented', () => {
  expect(nativeAccount({ organization: 'Example Org' }).label).toBe('Example Org');
  // Saying nothing is not the same as running on no account.
  expect(accountIsEmpty(nativeAccount({}))).toBe(true);
  expect(accountIsEmpty(nativeAccount({ subscriptionType: 'max' }))).toBe(false);
});

const machine = (name: string, sessions: unknown[]) =>
  ({
    machine: name,
    alias: null,
    ok: true,
    error: null,
    version: '0',
    release: null,
    behind: null,
    sessions,
  }) as never;
const row = (
  name: string,
  label: string | null,
  costUsd: number | null,
  planLimits: PlanLimits | null = null,
  provider: string | null = null,
) => ({
  name,
  account: label === null ? null : { label, organization: null, subscription: null, provider },
  costUsd,
  planLimits,
});

const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const limits = (percent: number, observedAt: string): PlanLimits => ({
  answer: 'known',
  plan: 'max',
  windows: [
    {
      key: 'five_hour',
      label: null,
      percent,
      windowMinutes: null,
      resetsAt: '2026-09-01T12:00:00.000Z',
      scope: null,
    },
  ],
  observedAt,
  error: null,
});

test('sessions sharing an account are grouped across machines, with their total', () => {
  const lines = accountLines([
    machine('host-a', [
      row('agent-a', 'one@example.test', 1.5),
      row('agent-b', 'two@example.test', 2),
    ]),
    machine('host-b', [row('agent-c', 'one@example.test', 0.25)]),
  ]);
  expect(lines[0]).toBe('accounts');
  expect(lines[1]).toBe('  one@example.test  $1.75  host-a:agent-a host-b:agent-c');
  // Nobody asked either session how full the plan is, and that is said rather than left blank.
  expect(lines[2]).toBe('    plan limits not read');
  expect(lines[3]).toBe('  two@example.test  $2.00  host-a:agent-b');
});

test('an unmeasured total is unknown, and a session naming no account is not a group', () => {
  const lines = accountLines([
    machine('host-a', [row('agent-a', 'one@example.test', null), row('agent-b', null, 5)]),
  ]);
  // Zero would claim the sessions cost nothing, which is a different statement from no measurement.
  expect(lines[1]).toBe('  one@example.test  cost unknown  host-a:agent-a');
  expect(lines).toHaveLength(3);
  // Nothing reported at all prints nothing: silence is not a group.
  expect(accountLines([machine('host-a', [row('agent-a', null, null)])])).toEqual([]);
});

test('sessions on one account share ONE plan window, not one window each', () => {
  // The model this exists against: ten sessions on one subscription drawn as ten independent
  // budgets. The window belongs to the account, so the fleet groups on it and reports it once.
  const [account, ...rest] = fleetAccounts([
    machine('host-a', [
      row('agent-a', 'one@example.test', 1, limits(50, '2026-09-01T09:00:00.000Z')),
      row('agent-b', 'one@example.test', 2, limits(77, '2026-09-01T09:59:00.000Z')),
    ]),
    machine('host-b', [row('agent-c', 'one@example.test', null)]),
  ]);
  expect(rest).toHaveLength(0);
  expect(account?.sessions).toEqual(['host-a:agent-a', 'host-a:agent-b', 'host-b:agent-c']);
  // Newest, not merged: two sessions describe the SAME window, and combining two readings of one
  // fact can show a window that has since reset beside one that has not.
  expect(account?.limits?.windows[0]?.percent).toBe(77);
  expect(account?.plan).toBe('max');
  const lines = accountLines(
    [
      machine('host-a', [
        row('agent-a', 'one@example.test', null, limits(77, '2026-09-01T09:59:00.000Z')),
      ]),
    ],
    NOW,
  );
  expect(lines[1]).toBe('  one@example.test [max]  cost unknown  host-a:agent-a');
  expect(lines[2]).toBe('    plan 5h 77% \u21bb2h');
});

test('one address on two providers is two plans, never one row showing the last one measured', () => {
  // Signing into both runtimes with the same address is ordinary. Grouping on the address alone
  // merged the two budgets and then displayed whichever had been measured most recently as "the"
  // limit — a Codex week shown to someone reading it as their Claude session's headroom.
  const accounts = fleetAccounts([
    machine('host-a', [
      row('agent-a', 'one@example.test', null, limits(91, '2026-09-01T09:59:00.000Z'), 'chatgpt'),
      row(
        'agent-b',
        'one@example.test',
        null,
        limits(10, '2026-09-01T09:00:00.000Z'),
        'firstParty',
      ),
    ]),
  ]);
  expect(accounts).toHaveLength(2);
  expect(
    accounts.map((account) => [account.provider, account.limits?.windows[0]?.percent]),
  ).toEqual([
    ['chatgpt', 91],
    ['firstParty', 10],
  ]);
  const lines = accountLines(
    [
      machine('host-a', [
        row('agent-a', 'one@example.test', null, limits(91, '2026-09-01T09:59:00.000Z'), 'chatgpt'),
      ]),
    ],
    NOW,
  );
  expect(lines[1]).toBe('  one@example.test (chatgpt) [max]  cost unknown  host-a:agent-a');
});

test('the JSON answer states what is only true at read time, so a consumer need not use a clock', () => {
  // A sample whose five-hour window ended an hour before this response was generated. Every
  // consumer deriving that from `resetsAt` and its own clock is one more place it can be got
  // wrong — and one of them drew a ninety-minute-old 100 % as the present, in red.
  const stale = limits(100, new Date(NOW - 90 * 60_000).toISOString());
  const [account] = fleetAccounts(
    [machine('host-a', [row('agent-a', 'one@example.test', 1, stale)])],
    Date.parse('2026-09-01T13:00:00.000Z'),
  );
  expect(account?.limits?.stale).toBe(true);
  expect(account?.limits?.windows[0]?.expired).toBe(true);
  // The stored sample is unchanged underneath: the projection says what is true now, it does not
  // rewrite what was measured then.
  expect(account?.limits?.windows[0]?.percent).toBe(100);
  expect(account?.limits?.observedAt).toBe(stale.observedAt);

  // The negative half, same data read while the window is still running.
  const [fresh] = fleetAccounts(
    [
      machine('host-a', [
        row('agent-a', 'one@example.test', 1, limits(100, new Date(NOW).toISOString())),
      ]),
    ],
    NOW,
  );
  expect(fresh?.limits?.stale).toBe(false);
  expect(fresh?.limits?.windows[0]?.expired).toBe(false);
});
