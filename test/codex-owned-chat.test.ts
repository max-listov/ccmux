import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import {
  applyOwnedCodexInput,
  applyOwnedCodexInterrupt,
  type ownedInputDependencies,
} from '../src/agent/codex/owned/input.ts';
import { OwnedCodexProjection } from '../src/agent/codex/owned/projection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/owned/status.ts';
import type { CodexAppRpc } from '../src/agent/codex/rpc.ts';
import { loadAcks } from '../src/chat/ackLog.ts';
import { managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { prepareMessageOperation, readMessageJournal } from '../src/chat/messageOperationStore.ts';
import { ChatCursorsSchema } from '../src/chat/messageSchema.ts';
import { deliverNativeRuntimePending } from '../src/chat/nativeRuntime.ts';
import { readRuntimeInput, writeRuntimeInput } from '../src/runtime/input.ts';
import { readRuntimeInterrupt, writeRuntimeInterrupt } from '../src/runtime/interrupt.ts';
import type { NativeSnapshot } from '../src/runtime/projectionSchema.ts';
import { managedRuntimeRoot } from '../src/runtime/status.ts';
import { privateRuntimeDirectory } from '../src/runtime/store.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { readChatHold, writeChatHold } from '../src/session/status.ts';
import frames from './fixtures/codex-pane/v0.147.0.json';
import { makeChatMessage, makeMachine, makeSession } from './helpers.ts';

/**
 * An owned Codex session receives mail the way every native runtime does: the daemon picks the
 * letter and queues it in `runtime/input`, and the owner — the process in the session's own pane —
 * starts the turn. What the daemon used to check before a direct `turn/start` is now the owner's:
 * whether a person is typing, the pane's composer, the thread's own status, identity and policy.
 */

function owner() {
  const m = makeMachine({ rcPrefix: 'host-a', stateDir: mkdtempSync('/tmp/ccmux-owned-input-') });
  const s = makeSession({
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: randomUUID(),
  });
  const msg = makeChatMessage({ id: randomUUID(), to: managedPeer(m.rcPrefix, s) });
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: 'idle' }, 0);
  let snapshot: NativeSnapshot = projection.snapshot();
  const calls: string[] = [];
  let pane = frames.idle;
  let nativeStatus: unknown = { type: 'idle' };
  let canAcceptDirectInput = true;
  let failStart = false;
  let collaborationModes: unknown[] = [
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
  ];
  let receipts: unknown[] = [];
  let resumeParams: unknown = null;
  let hold = '';
  const rpc: CodexAppRpc = {
    close() {},
    async request(method, params) {
      calls.push(method);
      const thread = {
        id: s.uuid,
        name: s.name,
        source: 'appServer',
        status: nativeStatus,
        canAcceptDirectInput,
      };
      if (method === 'thread/read') return { thread };
      if (method === 'thread/resume') {
        resumeParams = params;
        return { thread, model: 'model-current', reasoningEffort: 'low' };
      }
      if (method === 'collaborationMode/list') return { data: collaborationModes };
      if (method === 'turn/start') {
        // Recorded as in flight BEFORE the provider is asked, so a lost answer is visible.
        expect(readRuntimeInput(m, s)?.phase).toBe('dispatching');
        expect(params).toMatchObject({ threadId: s.uuid, clientUserMessageId: msg.id });
        if (s.launchRecipe?.collaborationMode !== undefined)
          expect(params).toMatchObject({
            collaborationMode: {
              mode: 'plan',
              settings: {
                model: 'model-current',
                reasoning_effort: 'medium',
                developer_instructions: null,
              },
            },
          });
        if (failStart) throw new Error('response lost after request was sent');
        return { turn: { id: 'native-turn' } };
      }
      if (method === 'thread/turns/list') return { data: receipts };
      if (method === 'turn/interrupt') return {};
      throw new Error(`unexpected RPC ${method}`);
    },
  };
  const deps: typeof ownedInputDependencies = {
    sessions: () => [s],
    typing: async () => false,
    gate: async (_m, _name, enabled) => {
      calls.push(enabled ? 'ungate' : 'gate');
      return true;
    },
    capture: async () => {
      calls.push('capture');
      return pane;
    },
    hold: async (_name, _id, reason) => {
      hold = reason;
    },
    clearHold: () => {
      hold = '';
    },
  };
  // The daemon's admission creates the session's private runtime directory before it queues.
  const queue = () => {
    privateRuntimeDirectory(managedRuntimeRoot(m, s));
    return writeRuntimeInput(m, s, {
      messageId: msg.id,
      nativeId: msg.id,
      text: msg.body,
      phase: 'queued',
    });
  };
  return {
    m,
    s,
    msg,
    calls,
    deps,
    projection,
    queue,
    input: () => readRuntimeInput(m, s),
    setSnapshot(value: NativeSnapshot) {
      snapshot = value;
    },
    setPane(value: string) {
      pane = value;
    },
    setNativeStatus(value: unknown) {
      nativeStatus = value;
    },
    setPolicy(value: boolean) {
      canAcceptDirectInput = value;
    },
    setCollaborationModes(value: unknown[]) {
      collaborationModes = value;
    },
    loseResponse() {
      failStart = true;
    },
    receipts(value: unknown[]) {
      receipts = value;
    },
    hold: () => hold,
    resumeParams: () => resumeParams,
    run: () => applyOwnedCodexInput(m, s, rpc, () => snapshot, deps),
    interrupt: () => applyOwnedCodexInterrupt(m, s, rpc, () => snapshot),
  };
}

const recipe = {
  id: 'input-policy',
  revision: 'r1',
  digest: 'a'.repeat(64),
  capabilities: ['input-requests' as const],
  collaborationMode: 'plan' as const,
};

test('the owner gates its pane, checks the thread and identity, and starts one turn', async () => {
  const f = owner();
  await f.queue();
  expect(await f.run()).toBe(true);
  expect(f.calls).toEqual(['gate', 'capture', 'thread/read', 'turn/start', 'ungate']);
  expect(f.input()).toMatchObject({ phase: 'accepted', turnId: 'native-turn' });
  // Accepted stays accepted: the next tick starts nothing.
  expect(await f.run()).toBe(false);
  expect(f.calls.filter((call) => call === 'turn/start')).toHaveLength(1);
});

test('a host recipe applies an installed collaboration preset before the turn starts', async () => {
  const f = owner();
  f.s.launchRecipe = recipe;
  await f.queue();
  expect(await f.run()).toBe(true);
  expect(f.calls).toEqual([
    'gate',
    'capture',
    'thread/resume',
    'collaborationMode/list',
    'turn/start',
    'ungate',
  ]);
  // Without this the response carries every turn of the thread, so a control read grows with the
  // session's age until it passes the connection's frame limit and delivery stops for good.
  expect(f.resumeParams()).toEqual({ threadId: f.s.uuid, excludeTurns: true });
});

test('an unsupported collaboration preset fails closed before the turn starts', async () => {
  const f = owner();
  f.s.launchRecipe = recipe;
  f.setCollaborationModes([
    { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
  ]);
  await f.queue();
  expect(await f.run()).toBe(false);
  expect(f.calls).not.toContain('turn/start');
  expect(f.input()?.phase).toBe('queued');
  expect(f.hold()).toBe('managed collaboration policy is unavailable');
});

test('a different Plan preset model cannot replace the loaded thread model', async () => {
  const f = owner();
  f.s.launchRecipe = recipe;
  f.setCollaborationModes([
    { name: 'Plan', mode: 'plan', model: 'preset-other-model', reasoning_effort: 'medium' },
  ]);
  await f.queue();
  expect(await f.run()).toBe(true); // the fake asserts turn/start still carries model-current
});

test('a busy, waiting or disconnected runtime is not touched at all', async () => {
  for (const state of ['working', 'waiting-approval', 'waiting-input', 'unknown'] as const) {
    const f = owner();
    f.setSnapshot({ ...f.projection.snapshot(), state });
    await f.queue();
    expect(await f.run()).toBe(false);
    expect(f.calls).toEqual([]);
  }
  const f = owner();
  f.setSnapshot({ ...f.projection.snapshot(), connected: false });
  await f.queue();
  expect(await f.run()).toBe(false);
  expect(f.calls).toEqual([]);
});

test('a letter waits while a person types, and over partial input, menus and unknown UI', async () => {
  const typing = owner();
  typing.deps.typing = async () => true;
  await typing.queue();
  expect(await typing.run()).toBe(false);
  expect(typing.calls).toEqual([]);
  expect(typing.hold()).toBe('a human typed in that pane a moment ago');
  expect(typing.input()?.phase).toBe('queued');
  for (const pane of [
    frames.partial,
    frames.partialWithDimCompletion,
    frames.queued,
    frames.menu,
    frames.commandApproval,
    frames.unknown,
    frames.notDrawn,
  ]) {
    const f = owner();
    f.setPane(pane);
    await f.queue();
    expect(await f.run()).toBe(false);
    // The pane's input is released on every path, or the person is locked out of their own pane.
    expect(f.calls).toEqual(['gate', 'capture', 'ungate']);
    expect(f.input()?.phase).toBe('queued');
    expect(f.hold()).not.toBe('');
  }
});

test("native status owns work: an empty client's background spinner cannot override native idle", async () => {
  const f = owner();
  f.setPane(frames.working);
  await f.queue();
  expect(await f.run()).toBe(true);
});

test('the thread is read again at submission, and a busy or refusing thread starts nothing', async () => {
  for (const status of [
    { type: 'active', activeFlags: [] },
    { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'notLoaded' },
    { type: 'systemError' },
  ]) {
    const f = owner();
    f.setNativeStatus(status);
    await f.queue();
    expect(await f.run()).toBe(false);
    expect(f.calls).not.toContain('turn/start');
    expect(f.calls).toContain('ungate');
  }
  const f = owner();
  f.setPolicy(false);
  await f.queue();
  expect(await f.run()).toBe(false);
  expect(f.calls).not.toContain('turn/start');
});

test('a changed registration starts nothing', async () => {
  const f = owner();
  f.deps.sessions = () => [{ ...f.s, uuid: randomUUID() }];
  await f.queue();
  expect(await f.run()).toBe(false);
  expect(f.calls).not.toContain('turn/start');
  expect(f.hold()).toBe('managed identity changed before native submission');
});

test('a lost response is never a second turn: settled from the provider record, or uncertain', async () => {
  const f = owner();
  f.loseResponse();
  await f.queue();
  await expect(f.run()).rejects.toThrow('response lost');
  expect(f.input()?.phase).toBe('dispatching');
  expect(f.calls.at(-1)).toBe('ungate');
  expect(f.hold()).toBe('native delivery failed: response lost after request was sent');
  // No record of it: uncertain, and never sent again.
  expect(await f.run()).toBe(false);
  expect(f.input()?.phase).toBe('uncertain');
  expect(await f.run()).toBe(false);
  expect(f.calls.filter((call) => call === 'turn/start')).toHaveLength(1);
  // The provider's record turns up: the turn is the one that carries this message's client id.
  f.receipts([
    {
      id: 'native-turn',
      status: 'interrupted',
      items: [{ type: 'userMessage', clientId: f.msg.id }],
    },
  ]);
  expect(await f.run()).toBe(false);
  expect(f.input()).toMatchObject({ phase: 'accepted', turnId: 'native-turn' });
  expect(f.calls.filter((call) => call === 'turn/start')).toHaveLength(1);
});

test('an interrupt stops the named running turn through the owner, and refuses any other', async () => {
  const f = owner();
  const generation = f.projection.snapshot().generation;
  const running: NativeSnapshot = {
    ...f.projection.snapshot(),
    state: 'working',
    turn: { id: 'native-turn', status: 'inProgress', startedAt: null },
  };
  f.setSnapshot(running);
  f.setNativeStatus({ type: 'active', activeFlags: [] });
  privateRuntimeDirectory(managedRuntimeRoot(f.m, f.s));
  await writeRuntimeInterrupt(f.m, f.s, { turnId: 'native-turn', generation, phase: 'queued' });
  await f.interrupt();
  expect(f.calls).toEqual(['thread/read', 'turn/interrupt']);
  expect(readRuntimeInterrupt(f.m, f.s)?.phase).toBe('accepted');

  const other = owner();
  other.setSnapshot({ ...running, generation: other.projection.snapshot().generation });
  privateRuntimeDirectory(managedRuntimeRoot(other.m, other.s));
  await writeRuntimeInterrupt(other.m, other.s, {
    turnId: 'another-turn',
    generation: other.projection.snapshot().generation,
    phase: 'queued',
  });
  await other.interrupt();
  expect(other.calls).not.toContain('turn/interrupt');
  expect(readRuntimeInterrupt(other.m, other.s)?.phase).toBe('rejected');
});

async function daemon() {
  const m = makeMachine({ rcPrefix: 'host-a', stateDir: mkdtempSync('/tmp/ccmux-owned-daemon-') });
  const s = makeSession({
    name: 'owned',
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: randomUUID(),
  });
  await writeSessionsUnlocked(m, [s]);
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: 'idle' }, 0);
  const writer = new OwnedCodexStatusWriter(m, s.name);
  await writer.write(projection.snapshot());
  const peer = managedPeer(m.rcPrefix, s);
  const key = managedPeerKey(peer);
  const msg = makeChatMessage({ id: randomUUID(), to: peer });
  prepareMessageOperation(m, s, msg.from, msg.id, 'a'.repeat(64));
  const cursors = ChatCursorsSchema.parse({});
  const run = () => deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false);
  return { m, s, projection, writer, peer, key, msg, cursors, run };
}

test('the daemon queues an owned Codex letter under its own id, like every native runtime', async () => {
  const f = await daemon();
  expect(await f.run()).toBe(1);
  // The message id IS the native id: it becomes the turn's client id, which finds a lost start.
  expect(readRuntimeInput(f.m, f.s)).toMatchObject({
    messageId: f.msg.id,
    nativeId: f.msg.id,
    phase: 'queued',
  });
  expect(f.cursors.pickups[f.key]?.native).toEqual({ phase: 'intent', turnId: null });
  expect(f.cursors.delivered[f.key]).toBe(1);
});

test('a letter settles on the turn the provider named, and a conditional one is acked only then', async () => {
  const f = await daemon();
  f.msg.defer = true;
  await f.run();
  const input = readRuntimeInput(f.m, f.s);
  if (input === null) throw new Error('fixture mailbox missing');
  await writeRuntimeInput(f.m, f.s, { ...input, phase: 'accepted', turnId: 'native-turn' });
  await f.writer.write({
    ...f.projection.snapshot(),
    state: 'working',
    turn: { id: 'native-turn', status: 'inProgress', startedAt: null },
  });
  await f.run();
  expect(f.cursors.pickups[f.key]?.native).toEqual({ phase: 'accepted', turnId: 'native-turn' });
  expect(loadAcks(f.m).has(f.msg.id)).toBe(false);
  await f.writer.write({
    ...f.projection.snapshot(),
    turn: { id: 'native-turn', status: 'interrupted', startedAt: null },
  });
  await f.run();
  expect(f.cursors.pickups[f.key]).toBeUndefined();
  expect(loadAcks(f.m).has(f.msg.id)).toBe(true);
  expect(readMessageJournal(f.m, f.s)?.records[0]).toMatchObject({
    messageId: f.msg.id,
    phase: 'interrupted',
    turnId: 'native-turn',
  });
});

test('a letter an owner leaves untaken beside an idle runtime says to restart the session', async () => {
  const f = await daemon();
  await f.run();
  const pickup = f.cursors.pickups[f.key];
  if (pickup === undefined) throw new Error('fixture pickup missing');
  // Fresh: the owner has had no chance yet, so nothing is said.
  await f.run();
  expect(readChatHold(f.s.name)).toBeNull();
  // Half a minute later, still queued, runtime idle, and the owner has said nothing about it.
  pickup.injectedAt = new Date(Date.now() - 60_000).toISOString();
  await f.run();
  expect(readChatHold(f.s.name)?.reason).toContain(`ccmux restart ${f.s.name}`);
  // An owner that is held by something says so, and that reason is not overwritten.
  await writeChatHold(f.s.name, f.msg.id, 'a human typed in that pane a moment ago');
  await f.run();
  expect(readChatHold(f.s.name)?.reason).toBe('a human typed in that pane a moment ago');
});
