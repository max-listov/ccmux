import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { openCodeTerminal } from '../src/agent/opencode/protocol.ts';
import { cmdAdopt } from '../src/commands/adopt.ts';
import type { CreateManagedInput } from '../src/commands/create.ts';
import { createManagedSession } from '../src/commands/create.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/config/sessions.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlCreateSchema, ControlModelsReadSchema } from '../src/control/schema.ts';
import { hasNativeRuntime, runtimeCapabilities } from '../src/runtime/capabilities.ts';
import { readRuntimeCatalog } from '../src/runtime/catalog.ts';
import { openCodeMessageId } from '../src/runtime/input.ts';
import { ManagedRuntimeStatusWriter, readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

function fixture() {
  const m = makeMachine({ stateDir: mkdtempSync('/tmp/ccmux-runtime-test-'), rcPrefix: 'host-a' });
  const s = makeSession({
    name: 'native-a',
    agent: 'opencode',
    runtime: 'native',
    registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: 'opencode', id: 'ses_native_a', version: '1.18.20' },
  });
  return { m, s, projection: new OpenCodeProjection(m, s, process.pid) };
}

test('runtime selection is separate from inference selection and unavailable drivers fail before mutation', async () => {
  const { m } = fixture();
  expect(
    ControlCreateSchema.parse({
      requestId: crypto.randomUUID(),
      name: 'a',
      workspace: '/work',
      runtime: 'opencode',
      modelSelection: { provider: 'external', model: 'model-a' },
    }),
  ).toMatchObject({ runtime: 'opencode', flags: [] });
  expect(
    ControlCreateSchema.safeParse({
      requestId: crypto.randomUUID(),
      name: 'a',
      workspace: '/work',
      runtime: 'shell',
      executable: 'sh',
    }).success,
  ).toBe(false);
  const workspace = mkdtempSync('/tmp/ccmux-runtime-workspace-');
  await expect(
    createControlSession(
      m,
      { requestId: crypto.randomUUID(), name: 'a', workspace, runtime: 'custom' },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(loadSessions(m)).toEqual([]);
  expect(existsSync(join(m.stateDir, 'control', 'create-requests.json'))).toBe(false);
  expect(readRuntimeCatalog(m).runtimes.find((row) => row.runtime === 'custom')).toMatchObject({
    availability: 'unavailable',
  });
  expect(runtimeCapabilities({ agent: 'claude', runtime: 'tui' })).toMatchObject({
    structured: false,
    approval: false,
  });
  expect(hasNativeRuntime({ agent: 'opencode', runtime: 'native' })).toBe(true);
  expect(ControlModelsReadSchema.parse({ runtime: 'opencode' }).runtime).toBe('opencode');
});

test('native create retries keep one registration and reject a changed runtime', async () => {
  const { m } = fixture();
  const workspace = mkdtempSync('/tmp/ccmux-runtime-create-');
  let calls = 0;
  const create = async (_m: typeof m, input: CreateManagedInput) => {
    calls++;
    const session = makeSession({
      name: input.name,
      agent: input.agent,
      dir: input.dir,
      runtime: 'native',
      registrationGeneration: input.registrationGeneration,
      nativeSession: { runtime: 'opencode', id: 'ses_one_writer', version: '1.18.20' },
    });
    await writeSessionsUnlocked(m, [session]);
    return session;
  };
  const input = {
    requestId: crypto.randomUUID(),
    name: 'native',
    workspace,
    runtime: 'opencode',
  } satisfies Parameters<typeof createControlSession>[1];
  const first = await createControlSession(m, input, new AbortController().signal, create);
  const second = await createControlSession(m, input, new AbortController().signal, create);
  expect(first.target).toEqual(second.target);
  expect(second.duplicate).toBe(true);
  expect(calls).toBe(1);
  expect(first.nativeSession?.id).toBe('ses_one_writer');
  await expect(
    createControlSession(m, { ...input, runtime: 'codex' }, new AbortController().signal, create),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const registered = loadSessions(m)[0];
  expect(registered).toBeDefined();
  if (!registered) throw new Error('Missing registration');
  await writeSessionsUnlocked(m, [{ ...registered, uuid: crypto.randomUUID() }]);
  await expect(
    createControlSession(m, input, new AbortController().signal, create),
  ).rejects.toMatchObject({ code: 'CORRUPT_STATE' });
  expect(calls).toBe(1);
});

test('CLI OpenCode defaults to native mode and unsupported adoption never enters Claude handling', async () => {
  const { m } = fixture();
  await expect(
    createManagedSession(
      { ...m, opencodeBin: undefined },
      { name: 'native', dir: '/tmp', agent: 'opencode', flags: [], router: false },
    ),
  ).rejects.toThrow('OpenCode executable is not configured');
  await expect(
    createManagedSession(m, {
      name: 'native',
      dir: '/tmp',
      agent: 'codex',
      runtime: 'native',
      flags: [],
      router: false,
    }),
  ).rejects.toThrow('does not use the native HTTP runtime');
  expect(await cmdAdopt(['opencode', crypto.randomUUID()])).toBe(1);
  expect(loadSessions(m)).toEqual([]);
});

test('native completion requires correlated assistant evidence, never idle or transport closure', () => {
  const { projection } = fixture();
  projection.start('msg_a');
  projection.status({ type: 'idle' });
  expect(projection.snapshot().turn?.status).toBe('inProgress');
  projection.unavailable('disconnected');
  expect(projection.snapshot()).toMatchObject({
    connected: false,
    state: 'unknown',
    turn: { status: 'inProgress' },
  });
  const message = {
    id: 'msg_assistant',
    sessionID: 'ses_native_a',
    role: 'assistant',
    parentID: 'msg_other',
    time: { created: 1, completed: 2 },
    finish: 'stop',
  } satisfies Parameters<typeof openCodeTerminal>[0];
  projection.message(message);
  expect(projection.snapshot().turn?.status).toBe('inProgress');
  projection.message({ ...message, parentID: 'msg_a', finish: 'tool-calls' });
  expect(projection.snapshot().turn?.status).toBe('inProgress');
  projection.message({ ...message, parentID: 'msg_a' });
  expect(projection.snapshot().turn?.status).toBe('completed');
  expect(projection.snapshot().nativeItems.at(-1)).toMatchObject({
    kind: 'terminal',
    turnId: 'msg_a',
  });
  expect(openCodeTerminal({ ...message, error: { name: 'MessageAbortedError', data: {} } })).toBe(
    'interrupted',
  );
});

test('native projection retains causal tool order, bounded data and exact input IDs', () => {
  const { projection } = fixture();
  projection.start('msg_a');
  projection.status({ type: 'busy' });
  projection.message({
    id: 'msg_assistant',
    sessionID: 'ses_native_a',
    role: 'assistant',
    parentID: 'msg_a',
    time: { created: 1 },
  });
  for (let index = 0; index < 200; index++)
    projection.part({
      id: `part_${index}`,
      messageID: 'msg_assistant',
      sessionID: 'ses_native_a',
      type: 'text',
      text: 'a'.repeat(9_000),
    });
  const snapshot = projection.snapshot();
  expect(snapshot.nativeItems.length).toBeLessThanOrEqual(128);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(128 * 1024);
  expect(snapshot.nativeItems.at(-1)?.text?.length).toBe(8192);
  projection.question({
    id: 'que_a',
    sessionID: 'ses_native_a',
    questions: [
      {
        header: 'Pick',
        question: 'Which?',
        options: [{ label: 'A', description: 'First' }],
        custom: false,
      },
    ],
  });
  expect(projection.snapshot()).toMatchObject({
    state: 'waiting-input',
    pendingRequests: [
      { requestId: 'que_a', questions: [{ id: '0', isOther: false, multiple: false }] },
    ],
  });
  projection.resolve('que_foreign');
  expect(projection.snapshot().pendingRequests).toHaveLength(1);
  projection.resolve('que_a');
  expect(projection.snapshot().pendingRequests).toHaveLength(0);
});

test('prepared native reader verifies registry, provider, lease and continuation identity', async () => {
  const { m, s, projection } = fixture();
  projection.status({ type: 'idle' });
  const writer = new ManagedRuntimeStatusWriter(m, s);
  await writer.write(projection.snapshot());
  expect(readManagedRuntimeStatus(m, s).status).toBe('live');
  expect(
    readManagedRuntimeStatus(m, { ...s, registrationGeneration: crypto.randomUUID() }).reason,
  ).toBe('identity-mismatch');
  expect(
    readManagedRuntimeStatus(m, {
      ...s,
      nativeSession: { runtime: 'opencode', id: 'ses_other', version: '1.18.20' },
    }).status,
  ).toBe('unavailable');
  expect(readManagedRuntimeStatus(m, s, Date.now() + 6_000).status).toBe('stale');
  projection.unavailable('disconnected');
  await writer.write(projection.snapshot());
  expect(readManagedRuntimeStatus(m, s).status).toBe('unavailable');
});

test('OpenCode native input IDs are deterministic and preserve native timestamp ordering', () => {
  const id = crypto.randomUUID();
  expect(openCodeMessageId(id, 1000)).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(openCodeMessageId(id, 1000)).toBe(openCodeMessageId(id, 1000));
  expect(openCodeMessageId(id, 1000) < openCodeMessageId(id, 1001)).toBe(true);
  expect(openCodeMessageId(id, 1000)).not.toBe(openCodeMessageId(crypto.randomUUID(), 1000));
});
