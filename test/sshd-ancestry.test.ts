import { expect, test } from 'bun:test';
import {
  hasAuthenticatedRemoteAncestor,
  isTrustedRemoteAncestor,
  parseProcStat,
  parsePsLine,
  remoteTransportAncestor,
} from '../src/chat/auth.ts';
import { makeMachine } from './helpers.ts';

const machine = makeMachine({
  remoteTransport: {
    peers: [],
    trustedAncestor: { executable: '/opt/relay/receiver', argument: 'serve' },
  },
});

// This walk gates every inbound remote message. It used to shell out ONCE PER ANCESTOR, which
// measured at ~104ms per message on Linux — the most expensive step in delivery, and the only one
// priced in process spawns. Reading the tree directly brought it to ~0.1ms. These tests pin the
// parsing that made the direct read possible, since that is where the new risk lives.

test('a command containing spaces and a closing paren is still parsed correctly', () => {
  // The exact input that defeats splitting on whitespace or on the FIRST ')'. A process can be named
  // anything, and a misparse here would silently deny delivery.
  expect(parseProcStat('42 (weird ) name) S 7 7 0 0 -1 4194304 100')).toEqual({
    parent: 7,
    command: 'weird ) name',
    args: '',
  });
});

test('an ordinary line parses, and the parent is the field after the state', () => {
  expect(parseProcStat('1234 (sshd) S 991 1234 1234 0 -1 4194560 200')).toEqual({
    parent: 991,
    command: 'sshd',
    args: '',
  });
});

test('garbage yields null rather than a guessed parent', () => {
  // Fail-closed matters more here than anywhere: a guessed parent could turn "not from the transport"
  // into "accepted".
  for (const bad of ['', 'no parens at all', '42 (unclosed S 7', '42 (x) S notanumber']) {
    expect(parseProcStat(bad)).toBeNull();
  }
});

test('the walk answers with a boolean and never throws on a nonexistent process', () => {
  expect(typeof hasAuthenticatedRemoteAncestor(machine, 999_999_99)).toBe('boolean');
  expect(hasAuthenticatedRemoteAncestor(machine, 1)).toBe(false); // pid 1 has no ancestors to inspect
});

// The wire is the second admitted transport, and the ONLY thing separating it from any other local
// process is this recognition. Both halves are load-bearing, so both are pinned.

test('the configured remote receiver is recognised through its interpreter', () => {
  // `comm` here is `bun`, a name shared with half the fleet — which is exactly why the match is on
  // the command line instead.
  const trusted = machine.remoteTransport?.trustedAncestor;
  expect(isTrustedRemoteAncestor('/usr/bin/runtime /opt/relay/receiver serve', trusted)).toBe(true);
  expect(isTrustedRemoteAncestor('/opt/relay/receiver serve', trusted)).toBe(true);
});

test('a caller is not a receiver: only the agent confers admission', () => {
  // `injected remote adapter call` is how a message LEAVES a machine. Anything descending from it is our own
  // outbound side, and treating that as an authenticated inbound transport would let any local
  // process launder itself into delivery by shelling out through the CLI.
  const trusted = machine.remoteTransport?.trustedAncestor;
  expect(isTrustedRemoteAncestor('/opt/relay/receiver call host-C -- ccmux list', trusted)).toBe(
    false,
  );
  expect(isTrustedRemoteAncestor('/usr/bin/runtime /opt/relay/receiver nodes', trusted)).toBe(
    false,
  );
  expect(isTrustedRemoteAncestor('/usr/bin/runtime /opt/other serve', trusted)).toBe(false);
  expect(isTrustedRemoteAncestor('', trusted)).toBe(false);
});

test('a ps line keeps its command line intact, spaces and all', () => {
  expect(parsePsLine('991 runtime /usr/bin/runtime /opt/relay/receiver serve')).toEqual({
    parent: 991,
    command: 'runtime',
    args: '/usr/bin/runtime /opt/relay/receiver serve',
  });
  expect(parsePsLine('garbage')).toBeNull();
});

test('the transport walk names which transport it found, or none', () => {
  expect(remoteTransportAncestor(machine, 1)).toBeNull();
  expect(remoteTransportAncestor(machine, 999_999_99)).toBeNull();
});
