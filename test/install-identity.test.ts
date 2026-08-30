import { expect, test } from 'bun:test';
import { renameRefusal } from '../src/commands/install.ts';

test('re-installing refuses to rename a machine that already has an identity', () => {
  const refusal = renameRefusal('alpha', 'beta', false);
  expect(refusal).not.toBeNull();
  expect(refusal).toMatch(/refusing to rename/i);
  // It must name BOTH sides: someone reading this needs to know what the machine is called now.
  expect(refusal).toContain('alpha');
  expect(refusal).toContain('beta');
});

test("re-installing with the machine's OWN prefix is accepted — this is the repair path", () => {
  expect(renameRefusal('alpha', 'alpha', false)).toBeNull();
});

test('omitting the prefix entirely is accepted: identity is read, not re-declared', () => {
  expect(renameRefusal('alpha', undefined, false)).toBeNull();
});

test('a deliberate rename still works, but only when asked for explicitly', () => {
  expect(renameRefusal('alpha', 'beta', true)).toBeNull();
});
