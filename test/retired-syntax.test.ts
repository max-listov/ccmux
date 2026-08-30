import { expect, test } from 'bun:test';
import { RETIRED, retiredNotice } from '../src/commands/retired.ts';

test('a retired flag answers with its replacement, not a usage line', () => {
  const notice = retiredNotice('restart', ['agent-a', '--then', 'do the thing']);
  expect(notice).not.toBeNull();
  expect(notice).toContain('ccmux msg');
  // The version is in the text because the misreading it exists to prevent is "my build is old".
  expect(notice).toContain('0.12.0');
  expect(notice).toMatch(/not an old build/i);
});

test('the notice says WHY, so nobody asks for the flag back', () => {
  const notice = retiredNotice('restart', ['agent-a', '--then', 'x']) ?? '';
  expect(notice).toMatch(/recorded|ledger/i);
});

test('the notice names the real source of the stale instruction', () => {
  // A session hit this because a rule file in ANOTHER repo still taught the flag. Telling it that
  // the rule is what is out of date — not the tool — is the whole point of the message.
  expect(retiredNotice('restart', ['a', '--then', 'x']) ?? '').toMatch(
    /rule.*out of date|tool is the current answer/i,
  );
});

test('live syntax passes straight through', () => {
  expect(retiredNotice('restart', ['agent-a'])).toBeNull();
  expect(retiredNotice('restart', ['--all'])).toBeNull();
  expect(retiredNotice('list', [])).toBeNull();
  expect(retiredNotice(undefined, [])).toBeNull();
});

test('free text is never mistaken for the flag — matching is verb-scoped and whole-token', () => {
  // A chat body may legitimately discuss the flag; `msg` is not the verb it belonged to.
  expect(retiredNotice('msg', ['agent-a', 'the --then flag is gone, use msg'])).toBeNull();
  // ...and a longer token that merely starts the same is not it.
  expect(retiredNotice('restart', ['agent-a', '--thenceforth'])).toBeNull();
  // Prose containing the token inside a larger argument is not a use of the flag either.
  expect(retiredNotice('restart', ['agent-a', 'note about --then'])).toBeNull();
});

test('every row carries what a reader needs to act', () => {
  for (const r of RETIRED) {
    expect(r.token.startsWith('-')).toBe(true);
    expect(r.replacement.length).toBeGreaterThan(0);
    expect(r.why.length).toBeGreaterThan(20);
    expect(r.removedIn).toMatch(/^\d+\.\d+\.\d+$/);
  }
});
