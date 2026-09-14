import { expect, test } from 'bun:test';
import { peerListMachine } from '../src/commands/fleetList.ts';
import { type RemoteResult, remoteFailureCause } from '../src/fleet/transport.ts';

const answer = (r: Partial<RemoteResult>): RemoteResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  transportFailed: false,
  delivery: 'received',
  ...r,
});

test("a peer whose ccmux failed is drawn with that failure's own first line, not a bare exit code", () => {
  const stderr = `${JSON.stringify({ command: 'list', err: 'Error: Native executable is unavailable\n    at x', level: 'error' })}\n`;
  expect(peerListMachine('host-b', 'host-b', answer({ code: 1, stderr }))).toMatchObject({
    ok: false,
    error: 'remote ccmux failed (exit 1): Error: Native executable is unavailable',
    sessions: [],
  });
  expect(peerListMachine('host-b', 'host-b', answer({ code: 1 })).error).toBe(
    'remote ccmux failed (exit 1): no reason reported',
  );
});

test("a transport failure keeps the transport's detail; unreadable output is not an empty machine", () => {
  expect(
    peerListMachine(
      'host-b',
      'remote',
      answer({ code: 255, transportFailed: true, failureDetail: 'peer offline' }),
    ).error,
  ).toBe('peer offline');
  expect(peerListMachine('host-b', 'host-b', answer({ stdout: 'not json' }))).toMatchObject({
    ok: false,
    error: 'unreadable list output (older ccmux?)',
  });
  expect(
    peerListMachine(
      'host-b',
      'host-b',
      answer({ stdout: JSON.stringify({ version: '9.9.9', sessions: [] }) }),
    ),
  ).toMatchObject({ ok: true, error: null, version: '9.9.9', sessions: [] });
});

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
