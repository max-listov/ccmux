import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
import { readTranscriptWindow } from '../src/context/transcriptWindow.ts';
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
import type { MachineConfig, Session } from '../src/types.ts';

const FAKE_ACP_SCRIPT = `#!/usr/bin/env bun
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('1.5.14');
  process.exit(0);
}

const dataDirMarker = join(process.cwd(), '.fake-data-dir');
const dataDir = existsSync(dataDirMarker) ? readFileSync(dataDirMarker, 'utf8').trim() : undefined;
const state = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  model: 'gemini-4-neon',
  thought: 'high',
  mode: 'default',
  cancelled: false,
  pendingReqId: 100,
};

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: state.thought,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: state.mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

const pendingHost = new Map();

function writeTranscript(line) {
  if (!dataDir) return;
  const dir = join(dataDir, 'brain', state.sessionId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'transcript.jsonl'), JSON.stringify(line) + '\\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl < 0) break;
    const raw = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = pendingHost.get(msg.id);
      if (resolve) {
        pendingHost.delete(msg.id);
        resolve(msg.result);
      }
      continue;
    }
    void handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'antigravity-cli', version: '1.5.14' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { load: {}, resume: {}, close: {} },
        },
      },
    });
    return;
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: state.sessionId, configOptions: configOptions() } });
    return;
  }
  if (method === 'session/resume' || method === 'session/load') {
    state.sessionId = params.sessionId;
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') state.model = params.value;
    if (params.configId === 'thought_level') state.thought = params.value;
    if (params.configId === 'mode') state.mode = params.value;
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === 'session/close') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'session/cancel') {
    state.cancelled = true;
    return;
  }
  if (method === 'session/prompt') {
    state.cancelled = false;
    const text = (params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const images = (params.prompt ?? []).filter((b) => b.type === 'image').length;
    writeTranscript({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: text,
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: state.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      },
    });
    if (text.includes('NEED_APPROVAL')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'write_file',
            name: 'write_file',
            rawInput: { path: 'a.txt' },
          },
        },
      });
      const reqId = ++state.pendingReqId;
      const decision = await new Promise((resolve) => {
        pendingHost.set(reqId, resolve);
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'session/request_permission',
          params: {
            sessionId: state.sessionId,
            toolCall: { toolCallId: 'call-1', title: 'write_file', name: 'write_file' },
            options: [
              { optionId: 'allow', kind: 'allow_once' },
              { optionId: 'deny', kind: 'reject_once' },
            ],
          },
        });
      });
      const approved = decision?.outcome?.optionId === 'allow';
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: approved ? 'completed' : 'failed',
            rawOutput: { approved },
          },
        },
      });
    }
    if (text.includes('HOLD_FOR_CANCEL')) {
      for (let i = 0; i < 60 && !state.cancelled; i++) {
        await Bun.sleep(50);
      }
      send({ jsonrpc: '2.0', id, result: { stopReason: state.cancelled ? 'cancelled' : 'end_turn' } });
      return;
    }
    const reply = \`model=\${state.model};effort=\${state.thought};mode=\${state.mode};images=\${images}\`;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: state.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: state.sessionId,
        update: { sessionUpdate: 'usage_update', used: 1200, size: 100000 },
      },
    });
    writeTranscript({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      model: state.model,
      input_tokens: 10,
      output_tokens: 5,
      thinking: 'thinking',
      content: reply,
    });
    send({
      jsonrpc: '2.0',
      id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 },
      },
    });
  }
}
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-agy-test-'));
  const binPath = join(dir, 'agy');
  const dataDir = join(dir, 'agy-data');
  const stateDir = join(dir, 'state');
  const workspace = join(dir, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(dataDir, 'installation_id'), 'test-install-id\n');
  writeFileSync(join(workspace, '.fake-data-dir'), dataDir);
  writeFileSync(binPath, FAKE_ACP_SCRIPT, 'utf8');
  chmodSync(binPath, 0o755);

  const m = {
    claudeBin: '/bin/sh',
    tmuxBin: '/bin/sh',
    antigravityBin: binPath,
    antigravityDataDir: dataDir,
    projectsDir: join(dir, 'claude-projects'),
    stateDir,
    rcPrefix: 'host-a',
    ensureInterval: 30,
    oomScoreAdj: null,
    permissionMode: 'auto',
    allowEscalatedUnderRoot: false,
    chatEnabled: true,
    externalInventory: false,
    bootLabel: 'com.ccmux.test',
    autoUpdate: false,
    updateCheckInterval: 300,
    autoUpdateSettleSeconds: 600,
    extraFlags: [],
    logLevel: 'info',
    resumePicker: 'full',
    trustPrompt: 'folder',
    quota: { probe: 'off', refreshMinutes: 15 },
    claudeNativeRuntime: false,
    remoteControl: false,
    codexCorrelationTimeoutMs: 5_000,
    launchRecipes: {},
    agentPolicies: {},
    messageApplications: {},
    externals: {},
    sessionEvents: false,
    releaseAllowPrivateHosts: false,
  } as unknown as MachineConfig;

  const session: Session = {
    name: 'agy-1',
    dir: workspace,
    uuid: crypto.randomUUID(),
    registrationGeneration: crypto.randomUUID(),
    flags: [],
    archived: false,
    resumeText: 'continue',
    agent: 'antigravity',
    runtime: 'native',
    promptModules: [],
  };

  return { dir, binPath, dataDir, stateDir, workspace, m, session };
}

test('antigravity preflight & negative controls: missing binary, old version, missing auth', () => {
  expect(parseAntigravityVersion('1.5.14')).toBe('1.5.14');
  expect(supportsAntigravityVersion('1.5.14')).toBe(true);
  expect(supportsAntigravityVersion('1.5.13')).toBe(false);
  expect(toAcpMode('acceptEdits')).toBe('accept-edits');
  expect(toAcpMode('bypassPermissions')).toBe('auto');
  expect(fromAcpMode('accept-edits')).toBe('acceptEdits');
  expect(fromAcpMode('auto')).toBe('bypassPermissions');

  const f = fixture();
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

test('antigravity host catalog & unknown model refusal before session creation', async () => {
  const f = fixture();
  try {
    const catalog = await readAntigravityModels(
      f.m,
      { runtime: 'antigravity', cursor: null, limit: 64, includeHidden: false },
      undefined,
      AbortSignal.timeout(10_000),
    );
    expect(catalog.source.runtime).toBe('antigravity');
    expect(catalog.data.map((m) => m.id)).toEqual(['gemini-4-neon', 'claude-opus-5-5']);
    expect(catalog.data[0]?.provider).toBe('antigravity');
    expect(catalog.data[0]?.inputModalities).toEqual(['text', 'image']);
    expect(catalog.data[0]?.supportedReasoningEfforts?.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'high',
    ]);

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
  const f = fixture();
  const prevDataDir = process.env.FAKE_AGY_DATA_DIR;
  process.env.FAKE_AGY_DATA_DIR = f.dataDir;
  const errors: unknown[] = [];
  const owner = new AntigravityOwner(f.m, f.session, async (err) => {
    errors.push(err);
  });
  try {
    await owner.open();
    const admitted = owner.identity;
    expect(admitted.nativeSession?.runtime).toBe('antigravity');
    expect(admitted.nativeSession?.id).toBe('11111111-1111-4111-8111-111111111111');
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
      expect(readManagedRuntimeStatus(f.m, owner2.identity).snapshot?.permissionMode).toBe(
        'acceptEdits',
      );
    } finally {
      await owner2.close();
    }
    expect(errors).toEqual([]);
  } finally {
    if (prevDataDir === undefined) delete process.env.FAKE_AGY_DATA_DIR;
    else process.env.FAKE_AGY_DATA_DIR = prevDataDir;
    await owner.close().catch(() => undefined);
    rmSync(f.dir, { recursive: true, force: true });
  }
});
