import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RemoteResult, runPeer } from '../src/fleet/transport.ts';
import { runWire } from '../src/fleet/wire.ts';
import { readWireResult } from '../src/fleet/wireProtocol.ts';
import { makeMachine } from './helpers.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const reply = (over: Record<string, unknown> = {}) => ({
  v: 2,
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  from: 'host-b',
  code: 0,
  stdout: '',
  stderr: '',
  failure: 'none',
  refusal: 'none',
  retryAfterMs: null,
  detail: '',
  truncated: false,
  ...over,
});
function door(fetch: (request: Request) => Response | Promise<Response>) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-door-certainty-'));
  const socket = join(root, 'agent.sock');
  const server = Bun.serve({ unix: socket, fetch });
  cleanup.push(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  return makeMachine({
    wire: { socket, peers: ['host-b'] },
    fleet: { 'host-b': 'unused-fallback' },
  });
}

test('valid command verdict, refusal and after-dispatch uncertainty are independent', () => {
  for (const [failure, delivery] of [
    ['none', 'received'],
    ['exec', 'received'],
    ['denied', 'not-sent'],
    ['offline', 'not-sent'],
    ['rejected', 'not-sent'],
    ['timeout', 'unknown'],
    ['transport', 'unknown'],
  ] satisfies Array<[string, RemoteResult['delivery']]>) {
    const result = readWireResult(reply({ failure, code: 7 }));
    expect(result.delivery).toBe(delivery);
    expect(result.transportFailed).toBe(failure !== 'none');
    if (failure === 'none') expect(result.code).toBe(7);
  }
  expect(readWireResult(reply({ truncated: true, code: 7, stdout: 'partial' }))).toMatchObject({
    delivery: 'received',
    transportFailed: false,
    code: 7,
    stdout: 'partial',
    stderr: expect.stringContaining('truncated'),
  });
});

test('invalid classifications, integers and contradictory failure fields stay unknown', () => {
  for (const over of [
    { code: 0.5 },
    { v: '2' },
    { id: 'bad' },
    { from: 'bad sender' },
    { failure: 'future-failure' },
    { refusal: 'future-refusal' },
    { refusal: 'policy' },
    { retryAfterMs: 1 },
    { failure: 'denied', refusal: 'capacity', retryAfterMs: -1 },
    { failure: 'denied', refusal: 'capacity', retryAfterMs: 3_600_001 },
  ])
    expect(readWireResult(reply(over))).toMatchObject({
      transportFailed: true,
      delivery: 'unknown',
    });
});

test('pre-dispatch cancellation sends nothing; post-dispatch cancellation is unknown', async () => {
  let calls = 0;
  const admitted = Promise.withResolvers<void>();
  const m = door(() => {
    calls++;
    admitted.resolve();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
      }),
    );
  });
  const cancelled = AbortSignal.abort();
  expect(
    await runWire(m, 'host-b', ['ccmux', 'restart', 'agent-a'], { signal: cancelled }),
  ).toMatchObject({ delivery: 'not-sent' });
  expect(calls).toBe(0);
  const controller = new AbortController();
  const result = runWire(m, 'host-b', ['ccmux', 'restart', 'agent-a'], {
    signal: controller.signal,
  });
  await admitted.promise;
  controller.abort();
  expect(await result).toMatchObject({ transportFailed: true, delivery: 'unknown' });
  expect(calls).toBe(1);
});

test('a configured Wire failure neither falls back to SSH nor repeats an arbitrary command', async () => {
  let calls = 0;
  const m = door(() => {
    calls++;
    return Response.json({ code: 0 });
  });
  expect(
    await runPeer(m, 'host-b', 'unused-fallback', ['ccmux', 'restart', 'agent-a']),
  ).toMatchObject({
    transportFailed: true,
    delivery: 'unknown',
    failureDetail: 'stitchwire agent returned an unreadable result',
  });
  expect(calls).toBe(1);
});

test('deadline after positive dispatch evidence is unknown, never unsent', async () => {
  let calls = 0;
  const m = door(() => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
      }),
    );
  });
  const result = await runWire(m, 'host-b', ['ccmux', 'restart', 'agent-a'], {
    signal: AbortSignal.timeout(100),
  });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ transportFailed: true, delivery: 'unknown' });
});

test('HTTP refusal alone is not a remote execution verdict', async () => {
  const m = door(() => new Response('private-detail', { status: 503 }));
  const result = await runWire(m, 'host-b', ['ccmux', 'restart', 'agent-a']);
  expect(result).toMatchObject({ transportFailed: true, delivery: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('private-detail');
});
