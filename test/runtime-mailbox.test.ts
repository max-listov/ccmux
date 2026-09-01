import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { requestRuntimeMcp, writeRuntimeMcpRequest } from '../src/runtime/mcpControl.ts';
import { ManagedRuntimeStatusWriter } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * The one mechanism now carrying every durable request between a caller and a live session.
 *
 * What is asserted here is the part that four separate copies each got slightly differently: a
 * repeated operation is one operation, a refusal is a refusal, and a request written for another
 * conversation is never answered as if it were this one.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const operationId = '77777777-7777-4777-8777-777777777777';

async function fixture() {
  const stateDir = mkdtempSync('/tmp/ccmux-mailbox-');
  roots.push(stateDir);
  const m = makeMachine({ stateDir });
  const generation = crypto.randomUUID();
  const s = makeSession({
    agent: 'opencode',
    runtime: 'native',
    registrationGeneration: generation,
    nativeSession: { runtime: 'opencode', id: 'ses_test', version: '1.18.20' },
  });
  const projection = new OpenCodeProjection(m, s, process.pid);
  const now = Date.now();
  await new ManagedRuntimeStatusWriter(m, s).write({
    ...projection.snapshot(),
    nativeSession: s.nativeSession,
    registrationGeneration: generation,
    machine: m.rcPrefix,
    session: s.name,
    threadId: s.uuid,
    generation,
    connected: true,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
    mcpServers: [{ name: 'files', status: 'connected', scope: null, tools: 3, error: null }],
  } as never);
  return { m, s, generation };
}

test('a completed request is answered from what the session republished', async () => {
  const { m, s, generation } = await fixture();
  await writeRuntimeMcpRequest(m, s, {
    operationId,
    generation,
    server: 'files',
    action: 'reconnect',
    phase: 'complete',
    reason: null,
  });
  // Not "a request completed" but "what the server's status is now": a reconnect the runtime
  // accepted and that then failed is not a working server.
  expect(
    await requestRuntimeMcp(
      m,
      s,
      { operationId, server: 'files', action: 'reconnect' },
      AbortSignal.timeout(5_000),
    ),
  ).toEqual({
    server: 'files',
    status: 'connected',
  });
});

test('a refused request is refused on replay, not retried', async () => {
  const { m, s, generation } = await fixture();
  await writeRuntimeMcpRequest(m, s, {
    operationId,
    generation,
    server: 'files',
    action: 'enable',
    phase: 'failed',
    reason: 'the runtime said no',
  });
  // The same operation asked twice is one operation. Rewriting it would restart something the
  // session may already have acted on.
  await expect(
    requestRuntimeMcp(
      m,
      s,
      { operationId, server: 'files', action: 'enable' },
      AbortSignal.timeout(5_000),
    ),
  ).rejects.toThrow('the runtime said no');
});

test('a receipt from another conversation is never answered as this one', async () => {
  const { m, s } = await fixture();
  await writeRuntimeMcpRequest(m, s, {
    operationId,
    generation: crypto.randomUUID(),
    server: 'files',
    action: 'enable',
    phase: 'complete',
    reason: null,
  });
  // Its generation belongs to a conversation that no longer exists, so it is not this session's
  // receipt — the request is written afresh and the poll finds the stale one and refuses.
  await expect(
    requestRuntimeMcp(
      m,
      s,
      { operationId, server: 'files', action: 'enable' },
      AbortSignal.timeout(1_000),
    ),
  ).rejects.toThrow();
});

test('a server this session never loaded is refused before anything is written', async () => {
  const { m, s } = await fixture();
  // Asking the runtime about something it does not have would report the silence as success.
  await expect(
    requestRuntimeMcp(
      m,
      s,
      { operationId, server: 'absent', action: 'enable' },
      AbortSignal.timeout(1_000),
    ),
  ).rejects.toThrow('no such MCP server');
});
