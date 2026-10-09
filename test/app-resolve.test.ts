import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type CodexAppRpc, CodexAppRpcRefusal } from '../src/agent/codex/rpc.ts';
import { type CodexAppFailureKind, CodexAppUnavailable } from '../src/agent/codex/socket.ts';
import { appResolveFailureText, resolveAppOutcome } from '../src/chat/appResolve.ts';
import { resolveRemoteCodexAppPeer } from '../src/commands/messagePeers.ts';
import type { RemoteResult } from '../src/fleet/transport.ts';
import { makeAppPeer, makeMachine, UUID } from './helpers.ts';

const machine = () => makeMachine({ rcPrefix: 'host-b', codexHome: '/tmp/codex' });
const thread = (id = UUID) => ({
  thread: {
    id,
    name: 'Exact App thread',
    source: 'appServer',
    status: { type: 'active', activeFlags: [] },
    canAcceptDirectInput: false,
  },
});
const rpc = (read: () => unknown): CodexAppRpc => ({
  request: async (method, params) => {
    expect(method).toBe('thread/read');
    expect(params).toEqual({ threadId: UUID, includeTurns: false });
    return read();
  },
  close() {},
});

test('exact App outcome reads once, closes, and does not resume or start a turn', async () => {
  let reads = 0;
  let closed = false;
  const client = rpc(() => {
    reads++;
    return thread();
  });
  client.close = () => {
    closed = true;
  };
  expect(await resolveAppOutcome(machine(), UUID, async () => client)).toEqual({
    ok: true,
    peer: makeAppPeer({ machine: 'host-b', name: 'Exact App thread' }),
  });
  expect(reads).toBe(1);
  expect(closed).toBe(true);
});

test('input and missing configuration refuse before connecting', async () => {
  const connect = async (): Promise<CodexAppRpc> => {
    throw new Error('must not connect');
  };
  expect(await resolveAppOutcome(machine(), 'invalid', connect)).toMatchObject({
    ok: false,
    failure: { phase: 'input', kind: 'invalid-address' },
  });
  expect(await resolveAppOutcome(makeMachine(), UUID, connect)).toMatchObject({
    ok: false,
    failure: { phase: 'connect', kind: 'configuration-unavailable' },
  });
});

test('endpoint refusals retain the source kind, phase and exact diagnostic', async () => {
  const kinds: CodexAppFailureKind[] = [
    'endpoint-absent',
    'endpoint-not-listening',
    'upgrade-refused',
    'connection-lost',
  ];
  for (const kind of kinds) {
    const error = new CodexAppUnavailable(kind, `Owner endpoint: ${kind}`);
    expect(
      await resolveAppOutcome(machine(), UUID, async () => {
        throw error;
      }),
    ).toEqual({
      ok: false,
      failure: { phase: 'connect', kind, message: error.message },
    });
  }
});

test('provider refusal and missing thread retain RPC code and full sentence without guessing a category', async () => {
  for (const sentence of [
    'exact thread not found',
    `provider capability refused: ${'detail '.repeat(50)}terminal reason`,
  ]) {
    const outcome = await resolveAppOutcome(machine(), UUID, async () =>
      rpc(() => {
        throw new CodexAppRpcRefusal(-32600, sentence);
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: {
        phase: 'thread/read',
        kind: 'provider-refused',
        providerCode: -32600,
        message: `App Server RPC failed: ${sentence}`,
      },
    });
    if (outcome.ok) throw new Error('refusal became success');
    expect(appResolveFailureText(outcome.failure)).toContain(sentence);
  }
});

test('identity and invalid response fail separately and close the provider connection', async () => {
  for (const [answer, kind] of [
    [thread(randomUUID()), 'identity-mismatch'],
    [{ thread: { id: UUID } }, 'invalid-provider-response'],
  ]) {
    let closed = false;
    const client = rpc(() => answer);
    client.close = () => {
      closed = true;
    };
    expect(await resolveAppOutcome(machine(), UUID, async () => client)).toMatchObject({
      ok: false,
      failure: { phase: 'thread/read', kind },
    });
    expect(closed).toBe(true);
  }
});

test('diagnostics mask secret shapes and exact environment secrets while retaining the reason', async () => {
  const secret = 'synthetic-private-key-value';
  const prior = process.env.CCMUX_TEST_API_KEY;
  process.env.CCMUX_TEST_API_KEY = secret;
  try {
    const outcome = await resolveAppOutcome(machine(), UUID, async () =>
      rpc(() => {
        throw new CodexAppRpcRefusal(
          -32000,
          `denied ${secret}; https://example.test/?api_key=opaque-secret; reason stays`,
        );
      }),
    );
    if (outcome.ok) throw new Error('refusal became success');
    expect(outcome.failure.message).not.toContain(secret);
    expect(outcome.failure.message).not.toContain('opaque-secret');
    expect(outcome.failure.message).toContain('reason stays');
  } finally {
    if (prior === undefined) delete process.env.CCMUX_TEST_API_KEY;
    else process.env.CCMUX_TEST_API_KEY = prior;
  }
});

const answer = (over: Partial<RemoteResult>): RemoteResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  transportFailed: false,
  delivery: 'received',
  ...over,
});
const remote = async (result: RemoteResult) => {
  let calls = 0;
  const outcome = await resolveRemoteCodexAppPeer(
    machine(),
    null,
    'host-b',
    `app/${UUID}`,
    async (_config, target, alias, argv) => {
      calls++;
      expect(target).toBe('host-b');
      expect(alias).toBeNull();
      expect(argv).toEqual(['ccmux', '_codex-app-resolve', UUID]);
      return result;
    },
  );
  expect(calls).toBe(1);
  return outcome;
};

test('remote resolve carries the complete typed refusal instead of only exit 1', async () => {
  const message = `specific refusal ${'detail '.repeat(50)}last reason`;
  const resolved = await remote(
    answer({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        failure: { kind: 'provider-refused', phase: 'thread/read', providerCode: -32600, message },
      }),
    }),
  );
  expect(resolved).toHaveProperty('error');
  if (!('error' in resolved)) throw new Error('refusal became peer');
  expect(resolved.error).toContain(message);
  expect(resolved.error).toContain('RPC -32600');
});

test('remote resolution pins machine and UUID and refuses inconsistent exits', async () => {
  const peer = makeAppPeer({ machine: 'host-b' });
  expect(await remote(answer({ stdout: JSON.stringify({ ok: true, peer }) }))).toEqual(peer);
  for (const altered of [
    { ...peer, machine: 'host-c' },
    { ...peer, threadId: randomUUID() },
  ])
    expect(
      await remote(answer({ stdout: JSON.stringify({ ok: true, peer: altered }) })),
    ).toHaveProperty('error', expect.stringContaining('identity mismatch'));
  expect(
    await remote(answer({ code: 1, stdout: JSON.stringify({ ok: true, peer }) })),
  ).toHaveProperty('error', expect.stringContaining('failing exit'));
  expect(
    await remote(
      answer({
        stdout: JSON.stringify({
          ok: false,
          failure: { phase: 'connect', kind: 'endpoint-absent', message: 'missing endpoint' },
        }),
      }),
    ),
  ).toHaveProperty('error', expect.stringContaining('successful exit'));
});

test('transport refusal and unreadable replies remain refusals with their reported reason', async () => {
  expect(
    await remote(
      answer({
        code: 255,
        transportFailed: true,
        delivery: 'not-sent',
        failureDetail: 'peer offline',
      }),
    ),
  ).toHaveProperty('error', expect.stringContaining('peer offline'));
  expect(
    await remote(answer({ code: 1, stdout: '{', stderr: 'owner endpoint refused' })),
  ).toHaveProperty('error', expect.stringContaining('owner endpoint refused'));
  expect(
    await remote(answer({ stdout: JSON.stringify(makeAppPeer({ machine: 'host-b' })) })),
  ).toHaveProperty('error', expect.stringContaining('invalid App resolution response'));
});
