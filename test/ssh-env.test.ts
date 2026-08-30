import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  droppedDeadAgentKeys,
  staleAgentSocket,
  withoutDeadAgentEnv,
} from '../src/agent/sshEnv.ts';

const liveSocket = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'ccmux-sock-')), 'agent.sock');
  writeFileSync(p, '');
  return p;
};

test('a socket that is already gone is dropped, with the connection vars beside it', () => {
  // The session outlives the login. Left in place, a dead socket makes ssh WAIT on it — a timeout
  // that reads as a permissions failure — instead of trying what the ssh config points at.
  const env = {
    SSH_AUTH_SOCK: '/tmp/ssh-gone/agent.404',
    SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22',
    PATH: '/bin',
  };
  const out = withoutDeadAgentEnv(env);
  expect(out.SSH_AUTH_SOCK).toBeUndefined();
  expect(out.SSH_CONNECTION).toBeUndefined();
  expect(out.PATH).toBe('/bin');
});

test('a LIVE forwarded socket is never removed — it may be the only credential the machine has', () => {
  // Deliberate: an on-disk key file is not evidence of being authorised on the peer. A fleet may
  // authenticate between machines only through a forwarded identity, and dropping a working socket
  // would take that away.
  const sock = liveSocket();
  const env = { SSH_AUTH_SOCK: sock, SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22', PATH: '/bin' };
  const out = withoutDeadAgentEnv(env);
  expect(out.SSH_AUTH_SOCK).toBe(sock);
  expect(out.SSH_CONNECTION).toBe('1.2.3.4 22 5.6.7.8 22');
});

test('an environment with no agent at all is returned unchanged', () => {
  const env = { PATH: '/bin', HOME: '/root' };
  expect(withoutDeadAgentEnv(env)).toBe(env);
  expect(staleAgentSocket(env)).toBe(false);
});

test('what was dropped is reportable, so the reason survives in the log', () => {
  expect(
    droppedDeadAgentKeys({ SSH_AUTH_SOCK: '/tmp/ssh-gone/a', SSH_TTY: '/dev/pts/0' }).sort(),
  ).toEqual(['SSH_AUTH_SOCK', 'SSH_TTY']);
  expect(droppedDeadAgentKeys({ SSH_AUTH_SOCK: liveSocket() })).toEqual([]);
});
