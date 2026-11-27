import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  antigravityModelsFromConfigOptions,
  freshHostCatalog,
  HOST_CATALOG_TTL_MS,
  readAntigravityModels,
  validateAntigravitySelection,
} from '../src/agent/antigravity/catalog.ts';
import { AntigravityOwner } from '../src/agent/antigravity/owner.ts';
import {
  antigravityAvailability,
  fromAcpMode,
  parseAntigravityVersion,
  preflightAntigravity,
  supportsAntigravityVersion,
  toAcpMode,
} from '../src/agent/antigravity/preflight.ts';
import {
  antigravityTranscriptPath,
  parseAntigravityTranscript,
} from '../src/agent/antigravity/transcript.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { readContent } from '../src/content/read.ts';
import { readTranscriptWindow } from '../src/context/transcriptWindow.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { readRuntimeCatalog } from '../src/runtime/catalog.ts';
import { writeRuntimeInput } from '../src/runtime/input.ts';
import { readRuntimeInterrupt, writeRuntimeInterrupt } from '../src/runtime/interrupt.ts';
import {
  nativeResponseFingerprint,
  readNativeReceipt,
  writeNativeCommand,
} from '../src/runtime/response.ts';
import { readSelection, writeSelection } from '../src/runtime/selection.ts';
import { readRuntimeMode, writeRuntimeMode } from '../src/runtime/sessionMode.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { appendSession } from '../src/session/registry.ts';
import { antigravityFixture } from './fixtures/antigravity.ts';

test('antigravity preflight & negative controls: missing binary, old version, missing auth', () => {
  expect(parseAntigravityVersion('1.5.14')).toBe('1.5.14');
  expect(supportsAntigravityVersion('1.5.14')).toBe(true);
  expect(supportsAntigravityVersion('1.5.13')).toBe(false);
  expect(toAcpMode('acceptEdits')).toBe('accept-edits');
  expect(toAcpMode('bypassPermissions')).toBe('auto');
  expect(fromAcpMode('accept-edits')).toBe('acceptEdits');
  expect(fromAcpMode('auto')).toBe('bypassPermissions');

  const f = antigravityFixture();
  try {
    // Missing binary
    expect(
      antigravityAvailability({ antigravityBin: undefined, antigravityDataDir: f.dataDir }),
    ).toEqual({ availability: 'unavailable', reason: 'runtime-not-configured' });
    expect(() =>
      preflightAntigravity({ antigravityBin: undefined, antigravityDataDir: f.dataDir }),
    ).toThrow(/not configured/i);

    // Missing auth state (empty dataDir)
    const emptyAuth = join(f.dir, 'no-auth');
    mkdirSync(emptyAuth, { recursive: true });
    expect(
      antigravityAvailability({ antigravityBin: f.binPath, antigravityDataDir: emptyAuth }),
    ).toEqual({ availability: 'unavailable', reason: 'runtime-auth-unavailable' });
    expect(() =>
      preflightAntigravity({ antigravityBin: f.binPath, antigravityDataDir: emptyAuth }),
    ).toThrow(/authentication/i);

    // Configured host publishes antigravity in runtime.list with expected capabilities
    const catalog = readRuntimeCatalog(f.m);
    const row = catalog.runtimes.find((r) => r.runtime === 'antigravity');
    expect(row).toBeDefined();
    expect(row?.mode).toBe('native');
    expect(row?.availability).toBe('configured');
    expect(row?.capabilities).toMatchObject({
      runtime: 'antigravity',
      structured: true,
      modelCatalog: true,
      modelSelection: true,
      nativeStream: true,
      interrupt: true,
      resume: true,
      imageInput: true,
      approval: true,
      permissionModes: true,
      history: true,
    });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a fresh host catalog answers the next host read without starting the CLI again', async () => {
  const f = antigravityFixture();
  const spawns = () => {
    try {
      return readFileSync(join(f.dir, 'acp-spawns.log'), 'utf8').trim().split('\n').length;
    } catch {
      return 0;
    }
  };
  const read = () =>
    readAntigravityModels(
      f.m,
      { runtime: 'antigravity', cursor: null, limit: 64, includeHidden: false },
      undefined,
      AbortSignal.timeout(10_000),
    );
  try {
    const first = await read();
    const afterFirst = spawns();
    expect(afterFirst).toBeGreaterThan(0);
    const second = await read();
    expect(spawns()).toBe(afterFirst);
    expect(second.data.map((m) => m.id)).toEqual(first.data.map((m) => m.id));
    expect(freshHostCatalog(f.m, Date.now() + HOST_CATALOG_TTL_MS + 1_000)).toBeNull();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('catalog rows carry the image modality only when the agent declared it', () => {
  const options = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [{ value: 'a', name: 'A' }],
    },
  ] as Parameters<typeof antigravityModelsFromConfigOptions>[0];
  expect(antigravityModelsFromConfigOptions(options, true)[0]?.inputModalities).toEqual([
    'text',
    'image',
  ]);
  expect(antigravityModelsFromConfigOptions(options, false)[0]?.inputModalities).toEqual(['text']);
});

test('a live session catalog gives reasoning efforts to the active model only', () => {
  const options = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }],
    },
  ] as Parameters<typeof antigravityModelsFromConfigOptions>[0];
  // Without each model's own answer, the active model's levels say nothing about another model.
  expect(
    antigravityModelsFromConfigOptions(options, false).map((m) => m.supportedReasoningEfforts),
  ).toEqual([[{ reasoningEffort: 'low', description: 'Low' }], undefined]);
  // With them, a model answered without thought_level gets none, even the active one.
  expect(
    antigravityModelsFromConfigOptions(options, false, {
      a: options.slice(0, 1),
      b: options,
    }).map((m) => m.supportedReasoningEfforts?.length),
  ).toEqual([undefined, 1]);
});

test('antigravity host catalog & unknown model refusal before session creation', async () => {
  const f = antigravityFixture();
  try {
    const catalog = await readAntigravityModels(
      f.m,
      { runtime: 'antigravity', cursor: null, limit: 64, includeHidden: false },
      undefined,
      AbortSignal.timeout(10_000),
    );
    expect(catalog.source.runtime).toBe('antigravity');
    expect(catalog.data.map((m) => m.id)).toEqual([
      'gemini-4-neon',
      'claude-opus-5-5',
      'gpt-oss-120b-medium',
    ]);
    expect(catalog.data[0]?.provider).toBe('antigravity');
    expect(catalog.data[0]?.inputModalities).toEqual(['text', 'image']);
    // Each model's own levels, read with that model selected; none for a model without them.
    expect(
      catalog.data.map((m) => [m.id, m.supportedReasoningEfforts?.map((e) => e.reasoningEffort)]),
    ).toEqual([
      ['gemini-4-neon', ['low', 'high']],
      ['claude-opus-5-5', ['low', 'medium', 'high']],
      ['gpt-oss-120b-medium', undefined],
    ]);
    expect(catalog.data[1]?.defaultReasoningEffort).toBe('high');
    expect(catalog.data[2]?.defaultReasoningEffort).toBeUndefined();

    // Known model passes, unknown model is refused before launch
    await validateAntigravitySelection(
      f.m,
      { provider: 'antigravity', model: 'claude-opus-5-5' },
      AbortSignal.timeout(10_000),
    );
    await expect(
      validateAntigravitySelection(
        f.m,
        { provider: 'antigravity', model: 'nonexistent-model-xyz' },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow(/absent from this host's catalog/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('antigravity owner full lifecycle: approval, selection update, permission mode, interrupt, resume and transcript.read', async () => {
  const f = antigravityFixture();
  const prevDataDir = process.env.FAKE_AGY_DATA_DIR;
  process.env.FAKE_AGY_DATA_DIR = f.dataDir;
  const errors: unknown[] = [];
  const owner = new AntigravityOwner(f.m, f.session, async (err) => {
    errors.push(err);
  });
  const publisher = new ControlPublisher(f.m);
  const server = createControlServer(f.m, publisher);
  const client = createControlClient({ socket: controlSocket(f.m) });
  const stop = new AbortController();
  try {
    await owner.open();
    const admitted = owner.identity;
    expect(admitted.nativeSession?.runtime).toBe('antigravity');
    expect(admitted.nativeSession?.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(admitted.nativeSession?.id).not.toBe(admitted.uuid);
    if (!admitted.nativeSession) throw new Error('missing admitted native session');
    await appendSession(f.m, admitted);
    const target = managedPeer(f.m.rcPrefix, admitted);
    const first = await client['native.read']({ target });
    expect(first).toMatchObject({ status: 'live', nativeId: admitted.nativeSession.id });
    const wrongThread = {
      ...admitted,
      nativeSession: { ...admitted.nativeSession, id: crypto.randomUUID() },
    };
    expect(() => readContent(f.m, wrongThread)).toThrow(
      expect.objectContaining({ code: 'UNAVAILABLE', status: 503 }),
    );
    const stream = await client.watchNative.withOptions(
      { target, cursor: { generation: first.generation, sequence: first.sequence } },
      { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]) },
    );
    expect(readSelection(f.m, admitted)?.options).toEqual({
      runtime: 'antigravity',
      model: { provider: 'antigravity', model: 'gemini-4-neon' },
      effort: 'high',
    });

    // 1. Permission mode update between turns
    const modeOp = crypto.randomUUID();
    await writeRuntimeMode(f.m, admitted, {
      operationId: modeOp,
      generation: admitted.registrationGeneration ?? '',
      mode: 'acceptEdits',
      phase: 'queued',
      reason: null,
    });
    await owner.tick();
    expect(readRuntimeMode(f.m, admitted)?.phase).toBe('complete');
    expect(readManagedRuntimeStatus(f.m, admitted).snapshot?.permissionMode).toBe('acceptEdits');

    // 2. Selection update + turn with approval
    await writeSelection(
      f.m,
      admitted,
      {
        revision: 1,
        options: {
          runtime: 'antigravity',
          model: { provider: 'antigravity', model: 'claude-opus-5-5' },
          effort: 'low',
        },
      },
      crypto.randomUUID(),
      '0'.repeat(64),
    );
    const turn1Id = crypto.randomUUID();
    await writeRuntimeInput(f.m, admitted, {
      messageId: turn1Id,
      nativeId: turn1Id,
      text: 'NEED_APPROVAL hello',
      phase: 'queued',
    });
    await owner.tick();

    // Wait for approval request to appear in snapshot
    let reqId: string | null = null;
    for (let i = 0; i < 40; i++) {
      const snap = readManagedRuntimeStatus(f.m, admitted).snapshot;
      if (snap?.state === 'waiting-approval' && snap.pendingRequests[0]) {
        reqId = snap.pendingRequests[0].requestId;
        break;
      }
      await Bun.sleep(25);
    }
    expect(reqId).not.toBeNull();
    const respOp = crypto.randomUUID();
    const generation = readManagedRuntimeStatus(f.m, admitted).snapshot?.generation ?? '';
    await writeNativeCommand(f.m, admitted.name, {
      operationId: respOp,
      generation,
      requestId: reqId ?? '',
      fingerprint: nativeResponseFingerprint({
        generation,
        requestId: reqId ?? '',
        kind: 'approval',
        decision: 'accept',
        answers: null,
      }),
      kind: 'approval',
      decision: 'accept',
      answers: null,
    });
    await owner.tick();
    expect(readNativeReceipt(f.m, admitted.name)?.outcome).toBe('submitted');

    // Wait for turn completion
    for (let i = 0; i < 40; i++) {
      const snap = readManagedRuntimeStatus(f.m, admitted).snapshot;
      if (snap?.turn?.id === turn1Id && snap.turn.status === 'completed' && snap.state === 'idle')
        break;
      await Bun.sleep(25);
    }
    const afterTurn1 = readManagedRuntimeStatus(f.m, admitted).snapshot;
    expect(afterTurn1?.turn?.status).toBe('completed');
    expect(afterTurn1?.contextUsage?.usedTokens).toBe(1200);
    const assistantText = afterTurn1?.nativeItems.find((i) => i.kind === 'assistant')?.text;
    expect(assistantText).toBe('model=claude-opus-5-5;effort=low;mode=accept-edits;images=0');
    const observed = new Set<string>();
    for await (const frame of stream) {
      expect(frame.nativeId).toBe(admitted.nativeSession.id);
      for (const record of frame.records) {
        if (record.turnId === turn1Id) observed.add(record.kind);
      }
      if (observed.has('terminal')) break;
    }
    for (const kind of ['assistant', 'reasoning-summary', 'tool', 'terminal']) {
      expect(observed).toContain(kind);
    }

    // 3. Interrupt a running turn
    const turn2Id = crypto.randomUUID();
    await writeRuntimeInput(f.m, admitted, {
      messageId: turn2Id,
      nativeId: turn2Id,
      text: 'HOLD_FOR_CANCEL',
      phase: 'queued',
    });
    await owner.tick();
    await writeRuntimeInterrupt(f.m, admitted, {
      generation,
      turnId: turn2Id,
      phase: 'queued',
    });
    await owner.tick();
    expect(readRuntimeInterrupt(f.m, admitted)?.phase).toBe('accepted');
    for (let i = 0; i < 40; i++) {
      const snap = readManagedRuntimeStatus(f.m, admitted).snapshot;
      if (snap?.turn?.id === turn2Id && snap.turn.status === 'interrupted') break;
      await Bun.sleep(25);
    }
    expect(readManagedRuntimeStatus(f.m, admitted).snapshot?.turn?.status).toBe('interrupted');

    // 4. Transcript read with cursor and no duplicates
    expect(antigravityTranscriptPath(admitted, f.m)).not.toBeNull();
    const tr = await readTranscriptWindow(f.m, admitted, { tail: 20 });
    expect(tr.available).toBe(true);
    expect(tr.messages.some((m) => m.role === 'user' && m.text?.includes('NEED_APPROVAL'))).toBe(
      true,
    );
    expect(
      tr.messages.some((m) => m.role === 'assistant' && m.text?.includes('model=claude-opus-5-5')),
    ).toBe(true);
    const parsedDirect = parseAntigravityTranscript(
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-25T10:00:00Z',
          content: 'hi',
        }),
      ],
      1,
    );
    expect(parsedDirect).toHaveLength(1);

    await owner.close();

    // 5. Restart and resume preserving nativeSession.id & threadId
    const owner2 = new AntigravityOwner(f.m, admitted, async (err) => {
      errors.push(err);
    });
    try {
      await owner2.open();
      expect(owner2.identity.uuid).toBe(admitted.uuid);
      expect(owner2.identity.nativeSession?.id).toBe(admitted.nativeSession?.id);
      expect(await client['native.read']({ target })).toMatchObject({
        status: 'live',
        nativeId: admitted.nativeSession.id,
      });
      expect(readManagedRuntimeStatus(f.m, owner2.identity).snapshot?.permissionMode).toBe(
        'acceptEdits',
      );
    } finally {
      await owner2.close();
    }
    expect(errors).toEqual([]);
  } finally {
    stop.abort();
    await client.close();
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    if (prevDataDir === undefined) delete process.env.FAKE_AGY_DATA_DIR;
    else process.env.FAKE_AGY_DATA_DIR = prevDataDir;
    await owner.close().catch(() => undefined);
    rmSync(f.dir, { recursive: true, force: true });
  }
});
