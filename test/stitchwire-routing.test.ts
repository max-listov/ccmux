import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { LOCAL_API_VERSION } from '@stitchwire/client';
import { runPeer } from '../src/fleet/transport.ts';
import { makeMachine, shortTempDir } from './helpers.ts';

test('direct Wire command calls use the agent and do not switch to SSH after refusal or uncertain delivery', async () => {
  const root = shortTempDir('door-');
  const socket = join(root, 'agent.sock');
  let result = { failure: 'none', refusal: 'none', truncated: true };
  const received: unknown[] = [];
  const door = Bun.serve({
    unix: socket,
    async fetch(req) {
      expect(new URL(req.url).pathname).toBe('/wire/call');
      received.push(await req.json());
      return Response.json({
        v: LOCAL_API_VERSION,
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        from: 'host-b',
        code: result.failure === 'none' ? 3 : 1,
        stdout: 'output',
        stderr: 'detail',
        detail: 'verdict',
        retryAfterMs: null,
        transportCause: null,
        ...result,
      });
    },
  });
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    remoteTransport: { kind: 'stitchwire', agentSocket: socket, peers: ['host-b'] },
  });
  const call = () =>
    runPeer(m, 'host-b', 'must-not-dial.invalid', ['ccmux', 'list', '--json'], {
      timeoutMs: 2000,
      stdin: 'test input',
    });
  try {
    expect(await call()).toMatchObject({
      code: 3,
      delivery: 'received',
      transportFailed: false,
      stdout: 'output',
    });
    expect(received[0]).toMatchObject({
      to: 'host-b',
      argv: ['ccmux', 'list', '--json'],
      stdin: 'test input',
    });
    result = { failure: 'denied', refusal: 'policy', truncated: false };
    const denied = await call();
    expect(denied).toMatchObject({
      code: 1,
      delivery: 'not-sent',
      transportFailed: true,
      permanent: true,
      failureDetail: 'denied/policy: verdict',
    });
    expect(denied.fallback).toBeUndefined();
    result = { failure: 'timeout', refusal: 'none', truncated: false };
    const timeout = await call();
    expect(timeout).toMatchObject({ code: 1, delivery: 'unknown', transportFailed: true });
    expect(timeout.fallback).toBeUndefined();
    expect(received).toHaveLength(3);
  } finally {
    door.stop(true);
  }
});
