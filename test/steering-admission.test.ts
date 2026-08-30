import { expect, test } from 'bun:test';
import { managedPeer } from '../src/chat/identity.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { withContextJournal } from '../src/context/store.ts';
import type { ManagedRuntimeSnapshot } from '../src/runtime/schema.ts';
import { SteeringInputSchema } from '../src/steering/schema.ts';
import { steerNativeTurn } from '../src/steering/service.ts';
import { readSteeringJournal } from '../src/steering/store.ts';
import frames from './fixtures/codex-pane/v0.147.0.json';
import { steeringFixture } from './steering-fixture.test.ts';

test('explicit steering persists intent then supplies exact active turn and client identity without overrides', async () => {
  const f = await steeringFixture();
  const receipt = await f.run();
  expect(receipt).toMatchObject({
    state: 'submitted',
    generation: f.input.generation,
    turnId: f.input.expectedTurnId,
    clientUserMessageId: `steer:${f.input.operationId}`,
    registrationGeneration: f.input.registrationGeneration,
  });
  expect(f.submissions).toEqual([
    {
      threadId: f.session.uuid,
      expectedTurnId: f.input.expectedTurnId,
      clientUserMessageId: `steer:${f.input.operationId}`,
      input: [{ type: 'text', text: f.input.body, text_elements: [] }],
    },
  ]);
  expect(f.calls).toEqual(['connect', 'gate', 'thread/read', 'turn/steer', 'ungate', 'close']);
  expect(await f.run()).toEqual(receipt);
  expect(f.submissions).toHaveLength(1);
});

test('idle, disconnected, stale generation or turn and pending approvals/input fail before native submission', async () => {
  for (const state of ['idle', 'waiting-approval', 'waiting-input', 'unknown'] satisfies Array<
    ManagedRuntimeSnapshot['state']
  >) {
    const f = await steeringFixture();
    f.setState({
      protocol: 1,
      status: 'live',
      reason: null,
      snapshot: { ...f.projection.snapshot(), state },
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'BUSY' });
    expect(f.calls).toEqual([]);
  }
  const missing = await steeringFixture();
  missing.setState({ protocol: 1, status: 'unavailable', reason: null, snapshot: null });
  await expect(missing.run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  const disconnected = await steeringFixture();
  disconnected.setState({
    protocol: 1,
    status: 'live',
    reason: null,
    snapshot: { ...disconnected.projection.snapshot(), connected: false },
  });
  await expect(disconnected.run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  for (const field of ['generation', 'expectedTurnId'] satisfies Array<
    'generation' | 'expectedTurnId'
  >) {
    const f = await steeringFixture();
    f.input[field] = crypto.randomUUID();
    await expect(f.run()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(f.calls).toEqual([]);
  }
  const request = await steeringFixture();
  const snapshot = request.projection.snapshot();
  snapshot.pendingRequests.push({
    requestId: 'request-a',
    rpcId: 3,
    kind: 'input',
    approvalKind: null,
    turnId: request.input.expectedTurnId,
    itemId: 'item-a',
    reason: null,
    decisions: [],
    questions: [],
    requestedAt: new Date().toISOString(),
  });
  request.setState({ protocol: 1, status: 'live', reason: null, snapshot });
  await expect(request.run()).rejects.toMatchObject({ code: 'BUSY' });
  expect(request.calls).toEqual([]);
});

test('typed partial input, recent typing and approval chrome are preserved without terminal injection', async () => {
  for (const pane of [
    frames.partial,
    frames.partialWithDimCompletion,
    frames.menu,
    frames.commandApproval,
    frames.unknown,
  ]) {
    const f = await steeringFixture();
    f.setPane(pane);
    await expect(f.run()).rejects.toMatchObject({ code: 'BUSY' });
    expect(f.calls).toEqual(['connect', 'gate', 'ungate', 'close']);
    expect(readSteeringJournal(f.machine, f.session).operations).toEqual([]);
  }
  const typed = await steeringFixture();
  typed.setTyping(true);
  await expect(typed.run()).rejects.toMatchObject({ code: 'BUSY' });
  expect(typed.calls).toEqual([]);
  const pending = await steeringFixture();
  pending.setStatus({ type: 'active', activeFlags: ['waitingOnApproval'] });
  await expect(pending.run()).rejects.toMatchObject({ code: 'BUSY' });
  expect(pending.submissions).toEqual([]);
});

test('unresolved context mutation and unsupported OpenCode CAS refuse before input admission', async () => {
  const f = await steeringFixture();
  await withContextJournal(f.machine, f.session, async (journal, persist) => {
    journal.operations.push({
      operationId: crypto.randomUUID(),
      generation: f.input.generation,
      state: 'uncertain',
      revision: 0,
      markerBefore: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await persist();
  });
  await expect(f.run()).rejects.toMatchObject({ code: 'CONTEXT_BUSY' });
  expect(f.calls).toEqual([]);
  const other = await steeringFixture();
  const session = {
    ...other.session,
    agent: 'opencode',
    runtime: 'native',
    nativeSession: { runtime: 'opencode', id: 'ses_fixture', version: '1.18.20' },
  } satisfies typeof other.session;
  await writeSessionsUnlocked(other.machine, [session]);
  await expect(
    steerNativeTurn(
      other.machine,
      other.principal,
      { ...other.input, target: managedPeer(other.machine.rcPrefix, session) },
      other.signal,
      other.deps,
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(other.calls).toEqual([]);
});

test('steering shape has one bounded text/image input and rejects policy, paths, executable and oversized UTF-8', async () => {
  const f = await steeringFixture();
  for (const extra of [
    { options: { model: 'other' } },
    { shell: 'anything' },
    { path: '/tmp/image.png' },
    { defer: true },
  ])
    expect(SteeringInputSchema.safeParse({ ...f.input, ...extra }).success).toBe(false);
  expect(SteeringInputSchema.safeParse({ ...f.input, body: '' }).success).toBe(false);
  expect(SteeringInputSchema.safeParse({ ...f.input, body: '🙂'.repeat(10_000) }).success).toBe(
    false,
  );
});
