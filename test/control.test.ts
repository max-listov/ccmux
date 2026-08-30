import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCli } from 'stitchkit/cli';
import { createToolInvoker } from 'stitchkit/tools/invoker';
import { readNativeCommand, writeNativeReceipt } from '../src/agent/codex/ownedControl.ts';
import { OwnedCodexProjection } from '../src/agent/codex/ownedProjection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/ownedStatus.ts';
import { rotateChatCredential } from '../src/chat/auth.ts';
import { managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { loadCursors, loadLedger, saveCursors } from '../src/chat/store.ts';
import { blockingInbound } from '../src/commands/wait.ts';
import { withSessionRegistryLock } from '../src/config/registryLock.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { ContentBuffer } from '../src/content/buffer.ts';
import { ContentWriter } from '../src/content/store.ts';
import { createControlClient, createControlProxy } from '../src/control/client.ts';
import { controlSocket, prepareControlDirectory } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import {
  CONTROL_MAX_BYTES,
  CONTROL_MAX_READERS,
  currentControlSnapshot,
} from '../src/control/schema.ts';
import { createControlServer } from '../src/control/server.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { observationExecCount } from '../src/monitoring/tmux.ts';
import { seedNativeSelection } from '../src/runtime/selection.ts';
import { nativeCatalogFixture } from './fixtures/native-catalog.ts';
import { makeMachine, makeSession } from './helpers.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(native = false) {
  const root = mkdtempSync('/tmp/ccmux-control-test-');
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    projectsDir: join(root, 'history'),
    chatEnabled: true,
  });
  const s = makeSession({
    name: 'agent-a',
    dir: root,
    agent: native ? 'codex' : 'claude',
    runtime: native ? 'app-server' : 'tui',
    chat: true,
    registrationGeneration: crypto.randomUUID(),
    ...(native ? { modelSelection: { provider: 'openai', model: 'model-a' } } : {}),
  });
  await writeSessionsUnlocked(m, [s]);
  const catalog = native ? nativeCatalogFixture(m, s) : null;
  if (native)
    await seedNativeSelection(m, s, {
      runtime: 'codex',
      model: { provider: 'openai', model: 'model-a' },
      mode: 'default',
    });
  const p = new ControlPublisher(m);
  const monitoring = new MonitoringPublisher();
  const publish = async () => {
    monitoring.begin(m);
    monitoring.sample(m, s, 1, '❯\n? for shortcuts', UNSEEN);
    p.publish(m, await monitoring.publish(m));
  };
  await publish();
  const owned = createControlServer(m, p);
  const socket = controlSocket(m);
  const client = createControlClient({ socket });
  cleanup.push(async () => {
    await client.close();
    p.close();
    await catalog?.stop(true);
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await owned.observability.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { m, s, p, publish, owned, client, socket, target: managedPeer(m.rcPrefix, s) };
}

test('Unix HTTP, CLI and peer-free tools share contract output and auth; no public listener', async () => {
  const f = await fixture();
  expect(f.owned.server.port).toBe(0);
  expect(statSync(f.socket).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.m.stateDir, 'control')).mode & 0o777).toBe(0o700);
  const read = await f.client.list();
  expect(read.status).toBe('live');
  expect(read.sessions[0]?.identity).toEqual(f.target);
  expect(await f.client.get({ target: f.target })).toMatchObject({ identity: f.target });
  const proxy = createControlProxy({ socket: f.socket });
  const invoker = createToolInvoker(proxy, { transport: 'MCP' });
  expect(await invoker.invokeOrThrow('sessions', {})).toEqual(read);
  const lines: string[] = [];
  let exitCode = -1;
  await createCli({
    name: 'control',
    version: '0.0.0',
    argv: ['sessions'],
    services: [proxy],
    stdin: async () => null,
    stdout: (line) => {
      lines.push(line);
    },
    stderr: (line) => {
      throw new Error(line);
    },
    exit: (code) => {
      exitCode = code;
    },
  });
  expect(exitCode).toBe(0);
  expect(JSON.stringify(lines)).toContain(f.s.uuid);
  const bad = createControlProxy({ socket: f.socket, session: f.s.name, credential: 'wrong' });
  await expect(
    createToolInvoker(bad, { transport: 'MCP' }).invokeOrThrow('sessions', {}),
  ).rejects.toThrow();
});

test('authorization precedes body handling, managed credentials rotate, and exact identities fail closed', async () => {
  const f = await fixture();
  const invalid = await fetch('http://ccmux.local/control/message', {
    unix: f.socket,
    method: 'POST',
    headers: {
      'x-ccmux-session': f.s.name,
      authorization: 'Bearer wrong',
      'content-type': 'application/json',
    },
    body: '{',
  });
  expect(invalid.status).toBe(401);
  const credential = rotateChatCredential(f.m, f.s);
  const managed = createControlClient({ socket: f.socket, session: f.s.name, credential });
  expect((await managed.list()).status).toBe('live');
  rotateChatCredential(f.m, f.s);
  await expect(managed.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  for (const target of [
    { ...f.target, threadId: crypto.randomUUID() },
    { ...f.target, machine: 'host-b' },
    { ...f.target, agent: 'codex' as const },
  ]) {
    await expect(f.client.get({ target })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
      status: 409,
    });
    await expect(f.client.start({ target })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    await expect(
      f.client.message({ target, messageId: crypto.randomUUID(), body: 'must not land' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  }
  expect(loadLedger(f.m)).toEqual([]);
  expect(
    (
      await fetch('http://ccmux.local/control/sessions', {
        unix: f.socket,
        headers: { origin: 'http://example.invalid' },
      })
    ).status,
  ).toBe(403);
});

test('message acceptance is durable, identity-authenticated and idempotent without starting a turn', async () => {
  const f = await fixture();
  const credential = rotateChatCredential(f.m, f.s);
  const client = createControlClient({ socket: f.socket, session: f.s.name, credential });
  const input = {
    target: f.target,
    messageId: crypto.randomUUID(),
    body: 'private message body',
    defer: true,
    task: 'sample-task',
  };
  expect(await client.message(input)).toEqual({
    accepted: true,
    duplicate: false,
    messageId: input.messageId,
    turnOptions: null,
  });
  expect(await client.message(input)).toEqual({
    accepted: true,
    duplicate: true,
    messageId: input.messageId,
    turnOptions: null,
  });
  await expect(client.message({ ...input, body: 'different' })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await expect(f.client.message(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(loadLedger(f.m)).toHaveLength(1);
  expect(loadLedger(f.m)[0]).toMatchObject({
    from: f.target,
    to: f.target,
    body: input.body,
    defer: true,
  });
  expect(JSON.stringify(await f.client.list())).not.toContain(input.body);
  const busy = f.owned.controls.mutations.acquire(f.s.name);
  expect(busy.outcome).toBe('leased');
  try {
    await expect(
      client.message({ ...input, messageId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'BUSY', status: 429 });
  } finally {
    if (busy.outcome === 'leased') busy.lease.release();
  }
  f.owned.controls.mutations.stopAdmission();
  await expect(client.message(input)).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
});

test('100 reads and resident subscribers reuse the producer; baseline, cancel and reconnect are real socket operations', async () => {
  const f = await fixture();
  const before = observationExecCount();
  const controllers = [new AbortController(), new AbortController()];
  const streams = await Promise.all(
    controllers.map((c) => f.client.watch.withOptions({ signal: c.signal })),
  );
  for (const stream of streams) expect((await stream.next()).value).toEqual(f.p.read());
  const reads = await Promise.all(Array.from({ length: 100 }, () => f.client.list()));
  expect(reads.every((s) => s.sequence === f.p.read().sequence)).toBe(true);
  expect(observationExecCount()).toBe(before);
  const pending = streams.map((stream) => stream.next());
  await f.publish();
  for (const next of pending) expect((await next).value.sequence).toBe(f.p.read().sequence);
  for (const c of controllers) c.abort();
  for (const stream of streams) await stream.return?.();
  for (let i = 0; i < 500 && f.p.subscribers; i++) await Bun.sleep(10);
  expect(f.p.subscribers).toBe(0);
  const reconnect = new AbortController();
  const stream = await f.client.watch.withOptions({ signal: reconnect.signal });
  expect((await stream.next()).value.sequence).toBe(f.p.read().sequence);
  reconnect.abort();
  await stream.return?.();
}, 10_000);

test('slow readers retain only the latest revision; capacity and abort-before-read do not leak', async () => {
  const f = await fixture();
  const controllers = Array.from({ length: CONTROL_MAX_READERS }, () => new AbortController());
  const streams = controllers.map((c) => f.p.subscribe(c.signal)[Symbol.asyncIterator]());
  expect(() => f.p.subscribe(new AbortController().signal)).toThrow('limit');
  for (let i = 0; i < 200; i++) await f.publish();
  for (const stream of streams)
    expect((await stream.next()).value.sequence).toBe(f.p.read().sequence);
  expect(Buffer.byteLength(JSON.stringify(f.p.read()))).toBeLessThan(CONTROL_MAX_BYTES);
  for (const controller of controllers) controller.abort();
  expect(f.p.subscribers).toBe(0);
  const aborted = new AbortController();
  aborted.abort();
  expect(() => f.p.subscribe(aborted.signal)).toThrow();
  expect(f.p.subscribers).toBe(0);
});

test.each(['abort', 'return-unread', 'return-baseline'] as const)(
  'configured control streams release and reuse Unix capacity on %s',
  async (terminal) => {
    const f = await fixture();
    for (let attempt = 0; attempt <= CONTROL_MAX_READERS; attempt++) {
      const stop = new AbortController();
      const stream = await f.client.watch.withOptions({ signal: stop.signal });
      expect(f.p.subscribers).toBe(1);
      if (terminal === 'return-baseline') expect((await stream.next()).value).toEqual(f.p.read());
      if (terminal === 'abort') stop.abort();
      else await stream.return?.();
      for (let i = 0; i < 100 && f.p.subscribers; i++) await Bun.sleep(10);
      expect(f.p.subscribers).toBe(0);
      if (terminal === 'abort') await stream.return?.();
    }
  },
  10_000,
);

test('a quiet control stream outlives its header deadline and abort releases a pending read', async () => {
  const f = await fixture();
  const client = createControlClient({ socket: f.socket, timeoutMs: 100 });
  cleanup.push(() => client.close());
  const stop = new AbortController();
  const stream = await client.watch.withOptions({ signal: stop.signal });
  expect((await stream.next()).value).toEqual(f.p.read());
  expect(f.p.subscribers).toBe(1);
  let settled = false;
  const pending = stream.next().then(
    () => {
      settled = true;
      return 'received';
    },
    () => {
      settled = true;
      return 'cancelled';
    },
  );
  await Bun.sleep(150);
  expect(settled).toBe(false);
  expect(f.p.subscribers).toBe(1);
  stop.abort();
  expect(await pending).toBe('cancelled');
  for (let i = 0; i < 100 && f.p.subscribers; i++) await Bun.sleep(10);
  expect(f.p.subscribers).toBe(0);
  await stream.return?.();
  const next = await client.watch();
  expect((await next.next()).value).toEqual(f.p.read());
  await next.return?.();
}, 5000);

test('oversize bodies refuse early and cancelled lock waiters cannot append later', async () => {
  const f = await fixture();
  const response = await fetch('http://ccmux.local/control/message', {
    unix: f.socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x'.repeat(70_000) }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: 'BAD_REQUEST', message: 'JSON body exceeds the 65536-byte limit' },
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const lock = withSessionRegistryLock(f.m, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const stop = new AbortController();
  try {
    const request = f.client.message.withOptions(
      { target: f.target, messageId: crypto.randomUUID(), body: 'must never append' },
      { signal: stop.signal },
    );
    const rejected = request.catch((error: unknown) => error);
    for (let i = 0; i < 50 && f.owned.controls.mutations.getSnapshot().active === 0; i++)
      await Bun.sleep(10);
    expect(f.owned.controls.mutations.getSnapshot().active).toBe(1);
    stop.abort();
    expect(await rejected).toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(f.owned.controls.mutations.getSnapshot().active).toBe(1);
  } finally {
    release.resolve();
    await lock;
  }
  for (let i = 0; i < 100 && f.owned.controls.mutations.getSnapshot().active; i++)
    await Bun.sleep(10);
  expect(f.owned.controls.mutations.getSnapshot().active).toBe(0);
  expect(loadLedger(f.m)).toEqual([]);
});

test('native approval/input/working states remain distinct; interruption cannot answer them', async () => {
  const f = await fixture(true);
  const p = new OwnedCodexProjection(f.m, f.s, process.pid);
  const writer = new OwnedCodexStatusWriter(f.m, f.s.name);
  for (const [flag, state] of [
    ['waitingOnApproval', 'waiting-approval'],
    ['waitingOnUserInput', 'waiting-input'],
  ] as const) {
    p.event({
      method: 'thread/status/changed',
      params: { threadId: f.s.uuid, status: { type: 'active', activeFlags: [flag] } },
    });
    await writer.write(p.snapshot());
    await f.publish();
    expect((await f.client.get({ target: f.target })).state).toBe(state);
    await expect(
      f.client.interrupt({
        target: f.target,
        generation: crypto.randomUUID(),
        turnId: 'unrelated',
      }),
    ).rejects.toMatchObject({ code: 'TURN_MISMATCH' });
    expect((await f.client.wait({ target: f.target, timeoutMs: 20 })).outcome).toBe('timeout');
  }
  p.event({
    method: 'thread/status/changed',
    params: { threadId: f.s.uuid, status: { type: 'idle' } },
  });
  await writer.write(p.snapshot());
  await f.publish();
  const waiting = f.client.wait({ target: f.target, timeoutMs: 1000 });
  await Bun.sleep(30);
  p.reconcile({ type: 'idle' }, p.revision);
  await writer.write(p.snapshot());
  await f.publish();
  expect((await waiting).outcome).toBe('idle');
  await f.client.message({
    target: f.target,
    messageId: crypto.randomUUID(),
    body: 'pending pickup',
  });
  const cursors = loadCursors(f.m);
  cursors.read[managedPeerKey(f.target)] = loadLedger(f.m).length;
  await saveCursors(f.m, cursors);
  expect(blockingInbound(f.m, f.s, Date.now())).toHaveLength(1);
  expect((await f.client.wait({ target: f.target, timeoutMs: 20 })).outcome).toBe('timeout');
  const retained = f.p.read();
  const stale = currentControlSnapshot(retained, Date.parse(retained.expiresAt) + 1);
  expect(stale).toMatchObject({
    status: 'stale',
    sessions: [{ state: 'unknown', availability: 'stale' }],
  });
  f.p.unavailable('producer-stopped');
  expect(f.p.read().sessions[0]).toMatchObject({ state: 'unknown', availability: 'unavailable' });
});

test('native feed is bounded, cursored and exact responses expose submission uncertainty honestly', async () => {
  const f = await fixture(true);
  const p = new OwnedCodexProjection(f.m, f.s, process.pid);
  const writer = new OwnedCodexStatusWriter(f.m, f.s.name);
  const content = new ContentBuffer(f.m, f.s, p.snapshot().generation);
  const contentWriter = new ContentWriter(f.m, f.s);
  const publishContent = async () => {
    contentWriter.offer(() => content.snapshot());
    await contentWriter.flush();
  };
  cleanup.push(() => contentWriter.close());
  p.reconcile({ type: 'idle' }, 0);
  p.event({
    method: 'item/completed',
    params: {
      threadId: f.s.uuid,
      turnId: 'turn-a',
      item: { id: 'user-a', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
    },
  });
  p.event({
    method: 'item/completed',
    params: {
      threadId: f.s.uuid,
      turnId: 'turn-a',
      item: {
        id: 'tool-a',
        type: 'commandExecution',
        status: 'completed',
        command: 'private',
        cwd: '/private',
      },
    },
  });
  p.request({
    id: 'approval-a',
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: f.s.uuid,
      turnId: 'turn-a',
      itemId: 'tool-a',
      startedAtMs: Date.now(),
      reason: 'confirm',
      availableDecisions: ['accept', 'decline'],
    },
  });
  content.tool('turn-a', 'tool-a', {
    callId: 'tool-a',
    name: 'commandExecution',
    lifecycle: 'completed',
    outcome: 'unknown',
    exitCode: null,
  });
  content.lifecycle('request', 'turn-a', 's:approval-a', 'requested', 'approval');
  await publishContent();
  await writer.write(p.snapshot());
  await f.publish();
  const baseline = await f.client.native({ target: f.target, cursor: null });
  expect(baseline).toMatchObject({
    reset: 'initial',
    pending: [{ requestId: 's:approval-a', kind: 'approval' }],
  });
  expect(baseline.baseline.map((item) => item.kind)).toEqual(['tool', 'request']);
  expect(JSON.stringify(baseline)).not.toContain('private');
  expect(JSON.stringify(baseline)).not.toContain('rpcId');
  const cursor = { generation: baseline.generation, sequence: baseline.sequence };
  expect(await f.client.native({ target: f.target, cursor })).toMatchObject({
    reset: null,
    records: [],
    baseline: [],
  });
  expect(
    (
      await f.client.native({
        target: f.target,
        cursor: { generation: crypto.randomUUID(), sequence: 0 },
      })
    ).reset,
  ).toBe('generation');

  const stop = new AbortController();
  const stream = await f.client.watchNative.withOptions(
    { target: f.target, cursor },
    { signal: stop.signal },
  );
  expect((await stream.next()).value).toMatchObject({ reset: null, records: [], baseline: [] });
  p.event({
    method: 'item/completed',
    params: {
      threadId: f.s.uuid,
      turnId: 'turn-a',
      item: { id: 'assistant-a', type: 'agentMessage', text: 'done' },
    },
  });
  content.text('assistant', 'turn-a', 'assistant-a', 'done', 'replace', true);
  await publishContent();
  await writer.write(p.snapshot());
  await f.publish();
  expect((await stream.next()).value.records).toMatchObject([
    { kind: 'assistant', itemId: 'assistant-a', text: 'done' },
  ]);
  stop.abort();
  await stream.return?.();

  const operationId = crypto.randomUUID();
  const response = f.client.respond({
    target: f.target,
    operationId,
    generation: baseline.generation,
    requestId: 's:approval-a',
    kind: 'approval',
    decision: 'decline',
    answers: null,
  });
  let command = null;
  for (let i = 0; i < 100 && command === null; i++) {
    command = readNativeCommand(f.m, f.s.name);
    await Bun.sleep(5);
  }
  expect(command).toMatchObject({ operationId, requestId: 's:approval-a', decision: 'decline' });
  assert(command);
  await writeNativeReceipt(f.m, f.s.name, {
    operationId,
    requestId: 's:approval-a',
    fingerprint: command.fingerprint,
    outcome: 'submitted',
    reason: null,
  });
  expect(await response).toEqual({ operationId, requestId: 's:approval-a', outcome: 'submitted' });
  p.resolveRequest('s:approval-a');
  await writer.write(p.snapshot());
  await f.publish();
  expect(
    await f.client.respond({
      target: f.target,
      operationId,
      generation: baseline.generation,
      requestId: 's:approval-a',
      kind: 'approval',
      decision: 'decline',
      answers: null,
    }),
  ).toEqual({ operationId, requestId: 's:approval-a', outcome: 'submitted' });
  await expect(
    f.client.respond({
      target: { ...f.target, threadId: crypto.randomUUID() },
      operationId,
      generation: baseline.generation,
      requestId: 's:approval-a',
      kind: 'approval',
      decision: 'decline',
      answers: null,
    }),
  ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  await expect(
    f.client.respond({
      target: f.target,
      operationId,
      generation: baseline.generation,
      requestId: 's:approval-a',
      kind: 'approval',
      decision: 'accept',
      answers: null,
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    f.client.respond({
      target: f.target,
      operationId: crypto.randomUUID(),
      generation: baseline.generation,
      requestId: 's:approval-a',
      kind: 'approval',
      decision: 'accept',
      answers: null,
    }),
  ).rejects.toMatchObject({ code: 'STALE_REQUEST' });
});

test('wait never returns a cached idle observation from before the call', async () => {
  const f = await fixture(true);
  const p = new OwnedCodexProjection(f.m, f.s, process.pid);
  p.reconcile({ type: 'idle' }, 0);
  const writer = new OwnedCodexStatusWriter(f.m, f.s.name);
  await writer.write(p.snapshot());
  await f.publish();
  await Bun.sleep(5);
  expect((await f.client.wait({ target: f.target, timeoutMs: 30 })).outcome).toBe('timeout');
  const pending = f.client.wait({ target: f.target, timeoutMs: 500 });
  await Bun.sleep(20);
  p.event({
    method: 'turn/started',
    params: { threadId: f.s.uuid, turn: { id: 'turn-current', status: 'inProgress' } },
  });
  await writer.write(p.snapshot());
  await f.publish();
  await Bun.sleep(20);
  p.event({
    method: 'turn/completed',
    params: { threadId: f.s.uuid, turn: { id: 'turn-current', status: 'interrupted' } },
  });
  await writer.write(p.snapshot());
  await f.publish();
  expect(await pending).toMatchObject({
    outcome: 'interrupted',
    state: { turn: { id: 'turn-current' } },
  });
});

test('protected socket directory rejects symlinks and foreign permissive state', () => {
  const root = mkdtempSync('/tmp/ccmux-control-path-');
  try {
    const m = makeMachine({ stateDir: root });
    mkdirSync(join(root, 'control'), { mode: 0o755 });
    expect(() => prepareControlDirectory(m)).toThrow('private');
    rmSync(join(root, 'control'), { recursive: true });
    symlinkSync(root, join(root, 'control'));
    expect(() => prepareControlDirectory(m)).toThrow('private');
    rmSync(join(root, 'control'));
    writeFileSync(join(root, 'control'), 'not a directory');
    expect(() => prepareControlDirectory(m)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
