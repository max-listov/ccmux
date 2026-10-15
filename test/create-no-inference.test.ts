import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sdkOptions } from '../src/agent/claude/native/sdk.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { loadCreateReceipts } from '../src/control/createReceipts.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { assertInferenceFreeCreate } from '../src/runtime/creation.ts';
import type { CreateManagedInput } from '../src/session/create.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-no-inference-'));
  roots.push(root);
  const parent = makeSession({
    name: 'parent',
    dir: root,
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
  });
  const delegation = {
    parent: {
      target: managedPeer('host-a', parent),
      registrationGeneration: parent.registrationGeneration ?? '',
    },
    policy: {
      access: 'read-only',
      readScope: 'host',
      workspace: root,
      network: false,
    },
  } satisfies NonNullable<Parameters<typeof createControlSession>[1]['delegation']>;
  const m = makeMachine({
    stateDir: join(root, 'state'),
    rcPrefix: 'host-a',
    delegationAuthorities: [delegation],
  });
  await writeSessionsUnlocked(m, [parent]);
  const input = {
    requestId: crypto.randomUUID(),
    name: 'child',
    workspace: root,
    runtime: 'claude',
    mode: 'native',
    initialization: 'no-inference',
    delegation,
    modelSelection: { provider: 'claude', model: 'haiku' },
  } satisfies Parameters<typeof createControlSession>[1];
  let calls = 0;
  const create = async (_m: typeof m, fields: CreateManagedInput) => {
    calls++;
    const session = makeSession({
      ...fields,
      uuid: fields.registrationGeneration,
      nativeSession: { runtime: 'claude', id: fields.registrationGeneration, version: 'fixture' },
    });
    await writeSessionsUnlocked(m, [parent, session]);
    return session;
  };
  return { m, input, create, calls: () => calls };
}

test('lost create ACK retries retain exact identity, delegation and initialization after durable reload', async () => {
  const f = await fixture();
  const first = await createControlSession(f.m, f.input, AbortSignal.timeout(5000), f.create);
  const retry = await createControlSession(f.m, f.input, AbortSignal.timeout(5000), f.create);
  expect(retry).toMatchObject({
    target: first.target,
    nativeSession: first.nativeSession,
    registrationGeneration: first.registrationGeneration,
    duplicate: true,
    modelSelection: f.input.modelSelection,
  });
  expect(loadCreateReceipts(f.m)[0]?.initialization).toBe('no-inference');
  const child = loadSessions(f.m).find((s) => s.name === 'child');
  expect(child?.initialization).toBe('no-inference');
  expect(child?.delegation).toEqual(first.delegation?.delegation);
  expect(f.calls()).toBe(1);
  for (const changed of [
    { initialization: 'allow-inference' },
    { modelSelection: { provider: 'claude', model: 'sonnet' } },
    {
      delegation: { ...f.input.delegation, deadlineAt: new Date(Date.now() + 10000).toISOString() },
    },
  ] satisfies Partial<Parameters<typeof createControlSession>[1]>[]) {
    await expect(
      createControlSession(f.m, { ...f.input, ...changed }, AbortSignal.timeout(5000), f.create),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  expect(f.calls()).toBe(1);
});

test('legacy paid receipt cannot be relabelled no-inference on a newly compatible mode', async () => {
  const f = await fixture();
  const ordinary = { ...f.input, initialization: undefined };
  await createControlSession(f.m, ordinary, AbortSignal.timeout(5000), f.create);
  await expect(
    createControlSession(f.m, f.input, AbortSignal.timeout(5000), f.create),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(f.calls()).toBe(1);
});

test('provider boundary requires explicit selection and delegation, and isolates hooks/plugins/tools', async () => {
  const f = await fixture();
  for (const modelSelection of [
    undefined,
    { provider: 'claude', model: 'default' },
    { provider: 'other', model: 'haiku' },
  ]) {
    expect(() =>
      assertInferenceFreeCreate({
        agent: 'claude',
        runtime: 'native',
        initialization: 'no-inference',
        delegation: f.input.delegation,
        modelSelection,
      }),
    ).toThrow('explicit provider/model');
  }
  const result = await createControlSession(f.m, f.input, AbortSignal.timeout(5000), f.create);
  const child = loadSessions(f.m).find((s) => s.name === result.target.session);
  if (!child) throw new Error('missing child');
  const options = sdkOptions({
    m: f.m,
    session: child,
    env: {},
    started: false,
    canUseTool: async () => ({ behavior: 'deny', message: 'test' }),
  });
  expect(options.model).toBe('haiku');
  expect(options.sessionId).toBe(result.nativeSession?.id);
  expect(options.settingSources).toEqual([]);
  expect(options.plugins).toEqual([]);
  expect(options.mcpServers).toEqual({});
  expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
  expect(Object.keys(options.hooks ?? {})).toEqual(['PreToolUse']);
});
