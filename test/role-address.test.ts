import { expect, test } from 'bun:test';
import {
  isRoleToken,
  ROLE_SIGIL,
  type RoleCandidate,
  resolveRole,
  roleOf,
} from '../src/chat/roleAddress.ts';
import { SessionSchema } from '../src/config/schema.ts';

// The failure this exists for is SILENT, which is what makes it expensive. A name is chosen once and
// it is usually the project's; a project has several sessions and only one owns a given decision. So
// an address picked from a project name resolves, delivers, exits zero — onto the neighbour. Nothing
// reports a problem, and the sender goes on believing it answered the owner. Measured on the fleet:
// an hour of exactly that.

const c = (
  name: string,
  role: string | null,
  dir = `/src/${name}`,
  lastText: string | null = null,
): RoleCandidate => ({ name, role, dir, lastText });

test('a role is asked for with a sigil, and a bare name is never mistaken for one', () => {
  // `@` is not decoration. Without it a role and a session name compete for one namespace, and an
  // address that is both would have to pick — and picking silently is the bug being removed.
  expect(isRoleToken('@contract-owner')).toBe(true);
  expect(roleOf('@contract-owner')).toBe('contract-owner');
  expect(isRoleToken('agent-a')).toBe(false);
  expect(isRoleToken('@')).toBe(false); // a sigil with nothing after it asks for nothing
});

test('one match resolves to that session', () => {
  const out = resolveRole('@contract-owner', [
    c('agent-a', 'contract-owner'),
    c('agent-b', 'firmware'),
  ]);
  expect(out).toEqual({ name: 'agent-a' });
});

test('two matches REFUSE — the whole point is that choosing silently is the failure', () => {
  const out = resolveRole('@firmware', [c('agent-a', 'firmware'), c('agent-b', 'firmware')]);
  expect('error' in out).toBe(true);
  const error = (out as { error: string }).error;
  expect(error).toContain('matches 2 sessions');
  expect(error).toContain('refusing to choose one');
  expect(error).toContain('agent-a');
  expect(error).toContain('agent-b');
});

test('the refusal carries what a reader needs to CHOOSE, not just that it failed', () => {
  // Otherwise a refusal is only a redirect to another command, and the sender guesses again from the
  // same information that misled them the first time.
  const out = resolveRole(
    '@firmware',
    [
      c('agent-a', 'firmware', '/src/panel', 'shipped the display fix'),
      c('agent-b', 'firmware', '/src/radio', 'still waiting on the contract'),
    ],
    'host-a:',
  );
  const error = (out as { error: string }).error;
  expect(error).toContain('/src/panel');
  expect(error).toContain('shipped the display fix');
  expect(error).toContain('/src/radio');
  // The address to retry with is spelled out, not left to be assembled.
  expect(error).toContain('host-a:agent-a');
  expect(error).toContain('host-a:agent-b');
});

test('a candidate that has said nothing says so, rather than showing an empty line', () => {
  const out = resolveRole('@firmware', [
    c('agent-a', 'firmware', '/src/a', null),
    c('agent-b', 'firmware', '/src/b', '   '),
  ]);
  expect((out as { error: string }).error).toContain('nothing said yet');
});

test('a multi-line last message is flattened — a refusal nobody reads to the end is a refusal that failed', () => {
  const out = resolveRole('@firmware', [
    c('agent-a', 'firmware', '/src/a', 'line one\nline two\n\nline three'),
    c('agent-b', 'firmware'),
  ]);
  const error = (out as { error: string }).error;
  const candidateBlock = error.slice(error.indexOf('agent-a'));
  expect(candidateBlock).toContain('line one line two line three');
});

test('no match names the roles that DO exist there', () => {
  const out = resolveRole(
    '@contract-owner',
    [c('agent-a', 'firmware'), c('agent-b', 'panel'), c('agent-c', null)],
    'host-a:',
  );
  const error = (out as { error: string }).error;
  expect(error).toContain("no session matches role '@contract-owner' on host-a");
  expect(error).toContain(`${ROLE_SIGIL}firmware`);
  expect(error).toContain(`${ROLE_SIGIL}panel`);
});

test('no roles at all anywhere says how to declare one instead of listing nothing', () => {
  const out = resolveRole('@contract-owner', [c('agent-a', null), c('agent-b', null)]);
  expect((out as { error: string }).error).toContain('ccmux role <session> contract-owner');
});

test('a session with no role is invisible to role addressing, and that is ordinary', () => {
  // Absent is the normal state. Such a session is addressed by name exactly as before.
  const out = resolveRole('@firmware', [c('agent-a', null)]);
  expect('error' in out).toBe(true);
});

test('a role is an address token, so it lives under the address rules', () => {
  // A role carrying ':' or whitespace could not be typed as an address at all; accepting it would
  // create a role nobody can use and a schema that has to explain why.
  expect(SessionSchema.shape.role.safeParse('contract-owner').success).toBe(true);
  expect(SessionSchema.shape.role.safeParse('contract owner').success).toBe(false);
  expect(SessionSchema.shape.role.safeParse('host:owner').success).toBe(false);
  expect(SessionSchema.shape.role.safeParse('').success).toBe(false);
  expect(SessionSchema.shape.role.safeParse(undefined).success).toBe(true);
});
