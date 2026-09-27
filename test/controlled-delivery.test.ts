import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { observeCodexContent } from '../src/agent/codex/content.ts';
import { applyOwnedCodexInput } from '../src/agent/codex/owned/input.ts';
import { OwnedCodexProjection } from '../src/agent/codex/owned/projection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/owned/status.ts';
import { inspectNativeCodexInput } from '../src/agent/codex/pane.ts';
import type { CodexAppRpc, CodexRpcEvent } from '../src/agent/codex/rpc.ts';
import { rotateChatCredential } from '../src/chat/auth.ts';
import { deliverPending } from '../src/chat/deliver.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { ContentProducer } from '../src/content/producer.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { observe } from '../src/events/observe.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { readRuntimeInput } from '../src/runtime/input.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { capturePaneStyled, newSession } from '../src/tmux/tmux.ts';
import { run } from '../src/util/spawn.ts';
import { communicationAuthorization } from './communication-fixture.ts';
import { nativeCatalogFixture } from './fixtures/native-catalog.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('controlled managed delivery: real menu hold, one provider admission, terminal evidence', async () => {
  const root = mkdtempSync('/tmp/ccmux-held-');
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    chatEnabled: true,
    projectsDir: join(root, 'history'),
    tmuxBin: Bun.which('tmux'),
    tmuxSocket: `held-${crypto.randomUUID()}`,
  });
  const s = makeSession({
    name: `fixture-${crypto.randomUUID()}`,
    dir: root,
    uuid: crypto.randomUUID(),
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
    modelSelection: { provider: 'openai', model: 'model-a' },
  });
  const state = join(root, 'pane');
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: 'idle' }, 0);
  const writer = new OwnedCodexStatusWriter(m, s.name);
  const content = new ContentProducer(m, s, projection.snapshot().generation);
  async function providerEvent(event: CodexRpcEvent) {
    observeCodexContent(content.buffer, s.uuid, event);
    content.publish();
    projection.event(event);
    await content.writer.flushPending();
    await writer.write(projection.snapshot());
  }
  const publisher = new ControlPublisher(m);
  const server = createControlServer(m, publisher);
  const catalog = nativeCatalogFixture(m, s);
  const credential = rotateChatCredential(m, s);
  const client = createControlClient({
    socket: controlSocket(m),
    session: s.name,
    credential,
  });
  const target = managedPeer(m.rcPrefix, s);
  const input = {
    target,
    registrationGeneration: s.registrationGeneration ?? '',
    messageId: crypto.randomUUID(),
    body: 'Controlled delivery fixture',
    communicationAuthorization,
    defer: true,
  };
  const readInput = {
    target,
    registrationGeneration: input.registrationGeneration,
    messageId: input.messageId,
  };
  const turnId = `fixture-turn-${crypto.randomUUID()}`;
  let starts = 0;
  // Only the external provider is simulated. Admission, hold, mailbox, receipt and control
  // transport are production code; this fixture never writes a hold or operation record.
  const rpc: CodexAppRpc = {
    close() {},
    async request(method, params) {
      if (method === 'collaborationMode/list')
        return {
          data: [{ name: 'Default', mode: 'default', model: null, reasoning_effort: 'medium' }],
        };
      if (method === 'thread/resume' || method === 'thread/read')
        return {
          thread: {
            id: s.uuid,
            name: s.name,
            source: 'appServer',
            status: { type: 'idle' },
            canAcceptDirectInput: true,
          },
          model: 'model-a',
          reasoningEffort: 'medium',
        };
      if (method !== 'turn/start') throw new Error(`Unexpected provider RPC: ${method}`);
      expect(params).toMatchObject({ threadId: s.uuid, clientUserMessageId: input.messageId });
      expect(readRuntimeInput(m, s)?.phase).toBe('dispatching');
      starts++;
      await providerEvent({
        method: 'turn/started',
        params: {
          threadId: s.uuid,
          turn: { id: turnId, status: 'inProgress' },
        },
      });
      return { turn: { id: turnId } };
    },
  };
  async function pane(next: 'menu' | 'idle') {
    writeFileSync(state, next);
    const signal = AbortSignal.timeout(5000);
    for (;;) {
      signal.throwIfAborted();
      const sample = inspectNativeCodexInput(await capturePaneStyled(m, s.name, 40));
      if (sample.state === (next === 'idle' ? 'deliverable' : 'menu')) return;
      await Bun.sleep(20);
    }
  }
  const owner = () => applyOwnedCodexInput(m, s, rpc, () => projection.snapshot());
  const monitoring = new MonitoringPublisher();
  const interactive = process.env.CCMUX_HELD_FIXTURE_INTERACTIVE === '1';
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error('Fixture interrupted'));
  async function publish() {
    const sample = await capturePaneStyled(m, s.name, 40);
    monitoring.begin(m);
    monitoring.sample(m, s, undefined, sample, observe(m, s, true, sample, Date.now()));
    publisher.publish(m, await monitoring.publish(m));
  }
  async function checkpoint(phase: string) {
    await publish();
    expect(
      (await client['session.list']()).sessions.some(
        (row) => row.identity.threadId === s.uuid && row.availability === 'live',
      ),
    ).toBe(true);
    if (!interactive) return;
    const manifest = join(root, 'consumer.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        client: { socket: controlSocket(m), session: s.name, credential },
        operation: readInput,
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({ phase, manifest, evidence: await client['message.operation'](readInput) }),
    );
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    const abort = new AbortController();
    const heartbeat = async () => {
      while (!abort.signal.aborted) {
        projection.event({
          method: 'thread/status/changed',
          params: {
            threadId: s.uuid,
            status: { type: 'idle' },
          },
        });
        await writer.write(projection.snapshot());
        await deliverPending(m);
        await owner();
        await publish();
        await Bun.sleep(250);
      }
    };
    const refreshing = heartbeat();
    try {
      await Promise.race([
        reader.question(`${phase}: Enter to continue (5 minute limit)\n`, {
          signal: AbortSignal.any([AbortSignal.timeout(300_000), interrupted.signal]),
        }),
        refreshing,
      ]);
    } finally {
      abort.abort();
      reader.close();
      await refreshing;
    }
  }
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await writeSessionsUnlocked(m, [s]);
    await content.writer.flushPending();
    await writer.write(projection.snapshot());
    writeFileSync(state, 'menu');
    await newSession(m, s.name, root, [
      process.execPath,
      join(import.meta.dir, 'fixtures/controlledDeliveryPane.ts'),
      state,
    ]);
    await pane('menu');
    expect((await client['message.operation'](readInput)).outcome).toBe('unavailable');
    const accepted = await client['message.send'](input);
    await deliverPending(m);
    expect(await owner()).toBe(false);
    const held = await client['message.operation'](readInput);
    expect(held.outcome).toBe('available');
    expect(held.evidence?.turnId).toBeNull();
    expect(held.evidence?.hold?.text).toContain('menu');
    expect(starts).toBe(0);
    expect(readRuntimeInput(m, s)?.phase).toBe('queued');
    const heldContent = await client['native.read']({ target, cursor: null });
    expect(heldContent.status).toBe('live');
    expect(heldContent.baseline).toEqual([]);
    expect(heldContent.records).toEqual([]);
    expect(heldContent.target).toEqual(target);
    expect(heldContent.registrationGeneration).toBe(input.registrationGeneration);
    await expect(
      client['native.read']({
        target: { ...target, threadId: crypto.randomUUID() },
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    await checkpoint('held');
    await deliverPending(m);
    expect(await owner()).toBe(false);
    expect(starts).toBe(0);
    expect(
      (await client['message.operation']({ ...readInput, messageId: crypto.randomUUID() })).outcome,
    ).toBe('unavailable');
    await pane('idle');
    expect(await owner()).toBe(true);
    await deliverPending(m);
    const admitted = await client['message.operation'](readInput);
    expect(admitted.evidence).toMatchObject({ state: 'admitted', turnId, hold: null });
    const answer = 'Controlled delivery completed.';
    await providerEvent({
      method: 'item/completed',
      params: {
        threadId: s.uuid,
        turnId,
        item: { id: 'fixture-answer', type: 'agentMessage', text: answer },
      },
    });
    await providerEvent({
      method: 'turn/completed',
      params: {
        threadId: s.uuid,
        turn: { id: turnId, status: 'completed' },
      },
    });
    await deliverPending(m);
    const completed = await client['message.operation'](readInput);
    expect(completed.evidence).toMatchObject({ state: 'completed', turnId, hold: null });
    const completedContent = await client['native.read']({ target, cursor: null });
    expect(completedContent.status).toBe('live');
    expect(completedContent.generation).toBe(heldContent.generation);
    expect(completedContent.baseline).toHaveLength(2);
    expect(completedContent.baseline).toMatchObject([
      { kind: 'assistant', turnId, text: answer, complete: true },
      { kind: 'terminal', turnId, status: 'completed', complete: true },
    ]);
    const delta = await client['native.read']({
      target,
      cursor: {
        generation: heldContent.generation,
        sequence: heldContent.sequence,
      },
    });
    expect(delta.reset).toBeNull();
    expect(delta.records.map((record) => record.kind)).toEqual(['assistant', 'terminal']);
    expect(
      (
        await client['native.read']({
          target,
          cursor: {
            generation: delta.generation,
            sequence: delta.sequence,
          },
        })
      ).records,
    ).toEqual([]);
    await checkpoint('completed');
    expect((await client['message.send'](input)).duplicate).toBe(true);
    await deliverPending(m);
    expect(await owner()).toBe(false);
    expect(starts).toBe(1);
    expect((await client['native.read']({ target, cursor: null })).sequence).toBe(
      completedContent.sequence,
    );
    console.log(
      JSON.stringify({
        fixture: 'controlled-delivery',
        provider: 'simulated',
        recordedAt: new Date().toISOString(),
        accepted,
        held,
        admitted,
        completed,
        heldContent,
        completedContent,
        starts,
      }),
    );
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await client.close();
    await content.close();
    publisher.close();
    monitoring.stop();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    await catalog.stop(true);
    await run(tmuxArgv(m, 'kill-server'));
    rmSync(root, { recursive: true, force: true });
  }
});
