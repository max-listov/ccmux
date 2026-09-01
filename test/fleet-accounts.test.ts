import { expect, test } from 'bun:test';
import { accountIsEmpty, nativeAccount } from '../src/agent/claude/native/account.ts';
import { accountLines } from '../src/commands/fleetList.ts';

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
const row = (name: string, label: string | null, costUsd: number | null) => ({
  name,
  account:
    label === null ? null : { label, organization: null, subscription: null, provider: null },
  costUsd,
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
  expect(lines[2]).toBe('  two@example.test  $2.00  host-a:agent-b');
});

test('an unmeasured total is unknown, and a session naming no account is not a group', () => {
  const lines = accountLines([
    machine('host-a', [row('agent-a', 'one@example.test', null), row('agent-b', null, 5)]),
  ]);
  // Zero would claim the sessions cost nothing, which is a different statement from no measurement.
  expect(lines[1]).toBe('  one@example.test  cost unknown  host-a:agent-a');
  expect(lines).toHaveLength(2);
  // Nothing reported at all prints nothing: silence is not a group.
  expect(accountLines([machine('host-a', [row('agent-a', null, null)])])).toEqual([]);
});
