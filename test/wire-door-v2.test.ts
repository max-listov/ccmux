import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFor } from '../src/fleet/address.ts';
import { peersOf, queuedForRetryNotice } from '../src/fleet/transport.ts';
import { refusalIsPermanent, runWire } from '../src/fleet/wire.ts';
import { callWireDoor } from '../src/fleet/wireDoor.ts';
import { makeMachine } from './helpers.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

// The door separates WHO said no from WHAT KIND of no it is, and the kinds behave oppositely.
// Reading only the first — which is what this code used to do — makes both mistakes at once: an hour
// of pointless retries against a permanent refusal, and a healthy-but-busy fleet drawn as broken.

test('capacity is temporary; policy and request are permanent', () => {
  expect(refusalIsPermanent('capacity')).toBe(false);
  expect(refusalIsPermanent('policy')).toBe(true);
  expect(refusalIsPermanent('request')).toBe(true);
});

test('an older door that cannot say leaves the kind UNKNOWN, and nothing is inferred', () => {
  // Not "assume temporary" and not "assume permanent": both are guesses, and a guess here either
  // throws mail away or retries something that will never work.
  expect(refusalIsPermanent(undefined)).toBeUndefined();
  expect(refusalIsPermanent('none')).toBeUndefined();
  expect(refusalIsPermanent('future-class')).toBeUndefined();
});

test('bounded Unix door preserves additive replies and exact command outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-wire-door-'));
  const socket = join(root, 'agent.sock');
  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const input = await request.json();
      expect(input).toMatchObject({ to: 'host-b', argv: ['ccmux', 'list', '--json'], stdin: null });
      return Response.json({
        v: 2,
        code: 7,
        stdout: 'owner-output',
        stderr: 'owner-error',
        failure: 'none',
        refusal: 'none',
        retryAfterMs: null,
        detail: '',
        truncated: false,
        additive: { supported: true },
      });
    },
  });
  cleanup.push(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  expect(existsSync(socket)).toBe(true);
  expect(
    await runWire(makeMachine({ wire: { socket, peers: ['host-b'] } }), 'host-b', [
      'ccmux',
      'list',
      '--json',
    ]),
  ).toEqual({ code: 7, stdout: 'owner-output', stderr: 'owner-error', transportFailed: false });
});

test('oversized and stalled local responses terminate and release their Unix transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-wire-bounds-'));
  const socket = join(root, 'agent.sock');
  let mode: 'large' | 'stalled' = 'large';
  const server = Bun.serve({
    unix: socket,
    fetch: () =>
      mode === 'large'
        ? new Response('x'.repeat(2048))
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
              },
            }),
          ),
  });
  cleanup.push(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  await expect(
    callWireDoor({ socket, body: '{}', deadlineMs: 1_000, maxResponseBytes: 1_024 }),
  ).rejects.toThrow();
  mode = 'stalled';
  await expect(
    callWireDoor({ socket, body: '{}', deadlineMs: 50, maxResponseBytes: 1_024 }),
  ).rejects.toThrow();
});

test('unavailable socket stays a transport failure and starts nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-wire-missing-'));
  const socket = join(root, 'missing.sock');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const result = await runWire(makeMachine({ wire: { socket, peers: ['host-b'] } }), 'host-b', [
    'ccmux',
    'list',
  ]);
  expect(result.transportFailed).toBe(true);
  expect(existsSync(socket)).toBe(false);
});

test('version, malformed data and every refusal class remain distinct', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-wire-outcomes-'));
  const socket = join(root, 'agent.sock');
  let reply: unknown = {};
  const server = Bun.serve({ unix: socket, fetch: () => Response.json(reply) });
  cleanup.push(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  const machine = makeMachine({ wire: { socket, peers: ['host-b'] } });
  const invoke = () => runWire(machine, 'host-b', ['ccmux', 'list']);

  reply = {
    v: 3,
    code: 0,
    stdout: '',
    stderr: '',
    failure: 'none',
    refusal: 'none',
    detail: '',
    truncated: false,
  };
  expect(await invoke()).toMatchObject({
    transportFailed: true,
    permanent: true,
    failureDetail: expect.stringContaining('API v3'),
  });

  reply = { v: 2, stdout: 'missing required code' };
  expect(await invoke()).toMatchObject({
    transportFailed: true,
    failureDetail: 'stitchwire agent returned an unreadable result',
  });

  for (const [failure, refusal, permanent] of [
    ['denied', 'policy', true],
    ['denied', 'request', true],
    ['denied', 'capacity', false],
    ['remote-exit', 'none', undefined],
    ['future-failure', 'future-refusal', undefined],
  ] satisfies Array<[string, string, boolean | undefined]>) {
    reply = {
      v: 2,
      code: 1,
      stdout: '',
      stderr: '',
      failure,
      refusal,
      retryAfterMs: refusal === 'capacity' ? 250 : null,
      detail: 'owner outcome',
      truncated: false,
      additive: true,
    };
    const result = await invoke();
    expect(result.transportFailed).toBe(true);
    expect(result.failureDetail).toContain(`${failure}${refusal === 'none' ? '' : `/${refusal}`}`);
    expect(result.permanent).toBe(permanent);
    if (refusal === 'capacity') expect(result.retryAfterMs).toBe(250);
  }
});

test('a permanent refusal is never described as something that will retry itself', () => {
  const temporary = queuedForRetryNotice('msg host-b:agent-b', 'capacity/…: node busy', 60, false);
  expect(temporary).toContain('QUEUED, not lost');
  expect(temporary).toContain('retries it automatically');

  const permanent = queuedForRetryNotice(
    'msg host-b:agent-b',
    'denied/policy: not on the allowlist',
    60,
    true,
  );
  expect(permanent).toContain('refused identically on every retry');
  expect(permanent).not.toContain('retries it automatically');
  // Still recorded — the record is the point — but the reader is not sent away reassured.
  expect(permanent).toContain('recorded in the outbox');
});

// ── the mail-loss regression ─────────────────────────────────────────────────────────────────────

test('a wire-only peer IS addressable, and a retry must not settle its mail as delivered', () => {
  // Measured on a live fleet: both servers reach the laptop over the wire and have no ssh alias for
  // it at all. The drain pass read only the ssh map, found nothing, and acked the envelope as
  // delivered — silently throwing away every retry to the one machine the wire exists for.
  const m = makeMachine({ rcPrefix: 'host-a', wire: { peers: ['host-b'] } });
  expect(peersOf(m).map((p) => `${p.machine}/${p.via}`)).toEqual(['host-b/wire']);
  const route = routeFor('host-b:agent-b', m);
  expect(route.kind).toBe('remote');
  if (route.kind === 'remote') expect(route.alias).toBeNull(); // no alias, and that is fine
});

test('a machine in neither map is genuinely unaddressable — that is the only settle case', () => {
  const m = makeMachine({ rcPrefix: 'host-a', fleet: { 'host-c': 'alias-c' } });
  expect(routeFor('host-b:agent-b', m).kind).toBe('error');
});

test('a fleet with only wire peers still drains — the pass may not require an ssh map', () => {
  // The guard used to be "no ssh fleet map → return", which meant a wire-only machine never drained
  // its outbox at all.
  expect(peersOf(makeMachine({ rcPrefix: 'host-a', wire: { peers: ['host-b'] } })).length).toBe(1);
  expect(peersOf(makeMachine({ rcPrefix: 'host-a' })).length).toBe(0);
});
