import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { applyOpenCodeInterrupt } from '../src/agent/opencode/interrupt.ts';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { ControlInterruptSchema } from '../src/control/schema.ts';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  requestRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../src/runtime/interrupt.ts';
import { openCodePermissionScope, PermissionScopeSchema } from '../src/runtime/permissionScope.ts';
import { ManagedRuntimeStatusWriter } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const stateDir = mkdtempSync('/tmp/ccmux-cancel-');
  roots.push(stateDir);
  const m = makeMachine({ stateDir });
  const s = makeSession({
    agent: 'opencode',
    runtime: 'native',
    registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: 'opencode', id: 'ses_test', version: '1.18.20' },
  });
  const projection = new OpenCodeProjection(m, s, process.pid);
  const writer = new ManagedRuntimeStatusWriter(m, s);
  projection.start('turn');
  projection.status({ type: 'busy' });
  const permission = {
    id: 'request',
    sessionID: 'ses_test',
    permission: 'external_directory',
    patterns: ['/tmp/narrow/*'],
    always: ['/tmp/*'],
    metadata: { secret: 'PRIVATE_PAYLOAD' },
  };
  projection.permission(permission);
  const terminal = () =>
    projection.message({
      id: 'assistant',
      sessionID: 'ses_test',
      role: 'assistant',
      parentID: 'turn',
      time: { created: Date.now() },
      error: { name: 'MessageAbortedError', data: {} },
    });
  return { m, s, projection, writer, permission, terminal };
}

test('native filesystem scope preserves narrow/requested and wider/session grants without raw metadata', () => {
  const f = fixture();
  const request = f.projection.snapshot().pendingRequests[0];
  expect(request?.scope).toEqual({
    operation: 'external_directory',
    kind: 'filesystem-patterns',
    requested: { patterns: ['/tmp/narrow/*'], omitted: 0, complete: true },
    session: { patterns: ['/tmp/*'], omitted: 0, complete: true },
  });
  expect(JSON.stringify(request)).not.toContain('PRIVATE_PAYLOAD');
  expect(openCodePermissionScope({ permission: 'bash', patterns: ['command SECRET'] })).toBeNull();
  const limited = openCodePermissionScope({
    permission: 'read',
    patterns: [...Array(9).fill('/tmp/*'), 'x'.repeat(1025), '\u001b[31m/tmp/*'],
  });
  expect(PermissionScopeSchema.parse(limited).requested).toEqual({
    patterns: Array(8).fill('/tmp/*'),
    omitted: 3,
    complete: false,
  });
  expect(limited?.session).toEqual({ patterns: [], omitted: 0, complete: false });
  expect(
    openCodePermissionScope({ permission: 'read', patterns: ['界'.repeat(400)] })?.requested,
  ).toEqual({ patterns: [], omitted: 1, complete: false });
});

test('terminal evidence clears exact pending requests without a permission-replied event and ignores late requests', () => {
  const f = fixture();
  f.projection.message({
    id: 'foreign',
    sessionID: 'ses_test',
    role: 'assistant',
    parentID: 'another',
    time: { created: 1 },
    error: { name: 'MessageAbortedError', data: {} },
  });
  expect(f.projection.snapshot().pendingRequests).toHaveLength(1);
  f.terminal();
  f.projection.permission(f.permission);
  expect(f.projection.snapshot().pendingRequests).toHaveLength(0);
  expect(f.projection.snapshot().turn?.status).toBe('interrupted');
  expect(
    f.projection.snapshot().nativeItems.filter((row) => row.stage === 'resolved'),
  ).toHaveLength(1);
});

test('generation/turn guard accepts suspended work only; caller must supply generation', () => {
  const f = fixture();
  const snapshot = f.projection.snapshot();
  for (const state of ['working', 'waiting-approval', 'waiting-input'] as const)
    expect(isCancellableTurn({ ...snapshot, state }, snapshot.generation, 'turn')).toBe(true);
  for (const state of ['idle', 'unknown'] as const)
    expect(isCancellableTurn({ ...snapshot, state }, snapshot.generation, 'turn')).toBe(false);
  expect(isCancellableTurn(snapshot, crypto.randomUUID(), 'turn')).toBe(false);
  expect(isCancellableTurn(snapshot, snapshot.generation, 'other')).toBe(false);
  expect(ControlInterruptSchema.safeParse({ target: {}, turnId: 'turn' }).success).toBe(false);
});

test('suspended cancellation uses one abort, no approval reply, and idempotent retry cannot affect the next turn', async () => {
  const f = fixture();
  await f.writer.write(f.projection.snapshot());
  const generation = f.projection.snapshot().generation;
  const requests: string[] = [];
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    throwOnError: true,
    fetch: Object.assign(
      async (request: string | Request | URL) => {
        requests.push(new URL(request instanceof Request ? request.url : request).pathname);
        f.terminal();
        return Response.json(true);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  await writeRuntimeInterrupt(f.m, f.s, { generation, turnId: 'turn', phase: 'queued' });
  await applyOpenCodeInterrupt(f.m, f.s, client, f.projection, AbortSignal.timeout(1000));
  await f.writer.write(f.projection.snapshot());
  await requestRuntimeInterrupt(f.m, f.s, generation, 'turn', AbortSignal.timeout(1000));
  f.projection.start('next');
  f.projection.status({ type: 'busy' });
  await applyOpenCodeInterrupt(f.m, f.s, client, f.projection, AbortSignal.timeout(1000));
  expect(requests).toEqual(['/session/ses_test/abort']);
  expect(f.projection.snapshot().turn?.id).toBe('next');
  await expect(
    requestRuntimeInterrupt(f.m, f.s, crypto.randomUUID(), 'turn', AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: 'TURN_MISMATCH' });
});

test('native settlement before queued cancellation refuses instead of aborting a newer turn', async () => {
  const f = fixture();
  const command = {
    generation: f.projection.snapshot().generation,
    turnId: 'turn',
    phase: 'queued' as const,
  };
  await writeRuntimeInterrupt(f.m, f.s, command);
  f.terminal();
  f.projection.start('next');
  let calls = 0;
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    fetch: Object.assign(
      async () => {
        calls++;
        return Response.json(true);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  await applyOpenCodeInterrupt(f.m, f.s, client, f.projection, AbortSignal.timeout(1000));
  expect(calls).toBe(0);
  expect(readRuntimeInterrupt(f.m, f.s)?.phase).toBe('rejected');
});

test('native settlement while persisting interrupt intent is rechecked before abort', async () => {
  const f = fixture();
  await writeRuntimeInterrupt(f.m, f.s, {
    generation: f.projection.snapshot().generation,
    turnId: 'turn',
    phase: 'queued',
  });
  const original = f.projection.snapshot.bind(f.projection);
  let reads = 0,
    calls = 0;
  const snapshot = spyOn(f.projection, 'snapshot').mockImplementation(() => {
    if (++reads === 2) f.terminal();
    return original();
  });
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    fetch: Object.assign(
      async () => {
        calls++;
        return Response.json(true);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  try {
    await applyOpenCodeInterrupt(f.m, f.s, client, f.projection, AbortSignal.timeout(1000));
    expect(calls).toBe(0);
    expect(readRuntimeInterrupt(f.m, f.s)?.phase).toBe('rejected');
  } finally {
    snapshot.mockRestore();
  }
});

test('lost abort acknowledgement remains uncertain and is not replayed', async () => {
  const f = fixture();
  await writeRuntimeInterrupt(f.m, f.s, {
    generation: f.projection.snapshot().generation,
    turnId: 'turn',
    phase: 'queued',
  });
  let calls = 0;
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    throwOnError: true,
    fetch: Object.assign(
      async () => {
        calls++;
        throw new Error('lost native ACK');
      },
      { preconnect: fetch.preconnect },
    ),
  });
  await expect(
    applyOpenCodeInterrupt(f.m, f.s, client, f.projection, AbortSignal.timeout(1000)),
  ).rejects.toBeDefined();
  expect(readRuntimeInterrupt(f.m, f.s)?.phase).toBe('uncertain');
  await applyOpenCodeInterrupt(f.m, f.s, client, f.projection, AbortSignal.timeout(1000));
  expect(calls).toBe(1);
});
