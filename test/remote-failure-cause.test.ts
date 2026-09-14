import { expect, test } from 'bun:test';
import { remoteFailureCause } from '../src/fleet/transport.ts';

test("a remote ccmux's JSON error line gives its first line as the cause", () => {
  const stderr = `${JSON.stringify({
    command: 'list',
    err: 'Error: Native executable is unavailable\n    at buildArgv (/x/ccmux.js:1:1)',
    level: 'error',
  })}\n`;
  expect(remoteFailureCause(stderr)).toBe('Error: Native executable is unavailable');
});

test('plain stderr gives its first non-empty line', () => {
  expect(remoteFailureCause('\n  bash: ccmux: command not found\nsecond line\n')).toBe(
    'bash: ccmux: command not found',
  );
});

test('nothing on stderr is no cause, not an empty one', () => {
  expect(remoteFailureCause('')).toBeNull();
  expect(remoteFailureCause('\n   \n')).toBeNull();
});

test('a cause is bounded to one short line', () => {
  expect(remoteFailureCause('x'.repeat(500))?.length).toBe(160);
});
