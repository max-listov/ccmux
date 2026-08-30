import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { preparedOpenCodeChoices, prepareOpenCodeCatalog } from '../src/agent/opencode/catalog.ts';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { loadLedger } from '../src/chat/store.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { acceptControlMessage } from '../src/control/message.ts';
import { readControlSelection, updateControlSelection } from '../src/control/selection.ts';
import { resolveApplicationPolicy } from '../src/policy/resolve.ts';
import { policySha256 } from '../src/policy/sources.ts';
import { seedNativeSelection } from '../src/runtime/selection.ts';
import type { NativeTurnOptions } from '../src/runtime/selectionSchema.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../src/runtime/status.ts';
import { makeCli, makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-policy-selection-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const body = 'Use the canonical application instructions.';
  const source = { id: 'source-a', path: join(root, 'agent.md'), sha256: policySha256(body) };
  writeFileSync(source.path, body, { mode: 0o600 });
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: join(root, 'state'),
    chatEnabled: true,
    opencodeBin: '/unavailable-native-provider',
    agentPolicies: {
      'policy-a': {
        runtime: 'opencode',
        revision: 'r1',
        trustedRoots: [root],
        agent: { name: 'agent-a', source },
        denyTools: [],
      },
    },
  });
  const policy = resolveApplicationPolicy(m, 'opencode', { id: 'policy-a', revision: 'r1' });
  const model = { provider: 'provider-a', model: 'model-a' };
  const s = makeSession({
    name: 'worker-a',
    dir: workspace,
    agent: 'opencode',
    runtime: 'native',
    chatEnabled: true,
    registrationGeneration: crypto.randomUUID(),
    applicationPolicy: policy.metadata,
    modelSelection: model,
    nativeSession: { runtime: 'opencode', id: 'ses_native', version: '1.18.20' },
  });
  await writeSessionsUnlocked(m, [s]);
  const options: NativeTurnOptions = { runtime: 'opencode', model };
  await seedNativeSelection(m, s, options);
  const projection = new OpenCodeProjection(m, s, process.pid);
  projection.status({ type: 'idle' });
  await new ManagedRuntimeStatusWriter(m, s).write(projection.snapshot());
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/agent')
        return Response.json([
          { name: 'agent-a', mode: 'primary', hidden: false },
          { name: 'agent-b', mode: 'primary', hidden: false },
        ]);
      if (path === '/config/providers')
        return Response.json({
          default: { 'provider-a': 'model-a' },
          providers: [
            {
              id: 'provider-a',
              models: {
                'model-a': {
                  id: 'model-a',
                  name: 'Model A',
                  status: 'active',
                  capabilities: { input: { text: true } },
                },
              },
            },
          ],
        });
      return new Response(null, { status: 404 });
    },
  });
  const signal = new AbortController().signal;
  try {
    await prepareOpenCodeCatalog(
      m,
      s,
      createOpencodeClient({ baseUrl: server.url.href, throwOnError: true }),
      signal,
    );
  } finally {
    await server.stop(true);
  }
  expect(preparedOpenCodeChoices(m, s).agents).toEqual(['agent-a', 'agent-b']);
  const target = managedPeer(m.rcPrefix, s);
  const identity = { target, registrationGeneration: s.registrationGeneration ?? s.uuid };
  const selectionPath = join(managedRuntimeRoot(m, s), 'selection.json');
  return { m, s, source, options, signal, target, identity, selectionPath };
}

test('message admission refuses another catalog agent before appending policy-incompatible work', async () => {
  const f = await fixture();
  const before = readFileSync(f.selectionPath, 'utf8');
  await expect(
    acceptControlMessage(
      f.m,
      makeCli(f.m.rcPrefix),
      {
        target: f.target,
        messageId: crypto.randomUUID(),
        body: 'hello',
        options: { ...f.options, agent: 'agent-b' },
      },
      f.signal,
    ),
  ).rejects.toMatchObject({
    code: 'APPLICATION_POLICY_UNAVAILABLE',
    message: 'Application policy is unavailable',
  });
  expect(loadLedger(f.m)).toEqual([]);
  expect(readFileSync(f.selectionPath, 'utf8')).toBe(before);
});

test('selection admission refuses a conflicting policy agent without journaling or consuming the operation', async () => {
  const f = await fixture();
  const before = readFileSync(f.selectionPath, 'utf8');
  const input = {
    ...f.identity,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    options: { ...f.options, agent: 'agent-b' },
  };
  await expect(updateControlSelection(f.m, input, f.signal)).rejects.toMatchObject({
    code: 'APPLICATION_POLICY_UNAVAILABLE',
    message: 'Application policy is unavailable',
  });
  expect(readFileSync(f.selectionPath, 'utf8')).toBe(before);
  expect(loadLedger(f.m)).toEqual([]);
  const accepted = await updateControlSelection(
    f.m,
    { ...input, options: { ...f.options, agent: 'agent-a' } },
    f.signal,
  );
  expect(accepted.current).toEqual({ revision: 1, options: { ...f.options, agent: 'agent-a' } });
});

for (const agent of ['agent-a', undefined]) {
  test(`policy permits ${agent ?? 'omitted'} agent in both defaults and explicit message options`, async () => {
    const f = await fixture();
    const options = agent === undefined ? f.options : { ...f.options, agent };
    const selection = await updateControlSelection(
      f.m,
      { ...f.identity, operationId: crypto.randomUUID(), expectedRevision: 0, options },
      f.signal,
    );
    expect(selection.current).toEqual({ revision: 1, options });
    const message = { target: f.target, messageId: crypto.randomUUID(), body: 'hello', options };
    const receipt = await acceptControlMessage(f.m, makeCli(f.m.rcPrefix), message, f.signal);
    expect(receipt.turnOptions).toEqual(selection.current);
    expect(
      (await acceptControlMessage(f.m, makeCli(f.m.rcPrefix), message, f.signal)).duplicate,
    ).toBe(true);
    expect(loadLedger(f.m)).toHaveLength(1);
    expect(loadLedger(f.m)[0]?.turnOptions).toEqual(selection.current);
    expect((await readControlSelection(f.m, f.identity, f.signal)).current).toEqual(
      selection.current,
    );
  });
}

test('changed canonical policy refuses both admission paths without persisted work', async () => {
  const f = await fixture();
  const before = readFileSync(f.selectionPath, 'utf8');
  writeFileSync(f.source.path, 'Changed canonical policy body', { mode: 0o600 });
  await expect(
    acceptControlMessage(
      f.m,
      makeCli(f.m.rcPrefix),
      { target: f.target, messageId: crypto.randomUUID(), body: 'hello' },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'APPLICATION_POLICY_UNAVAILABLE' });
  await expect(
    updateControlSelection(
      f.m,
      { ...f.identity, operationId: crypto.randomUUID(), expectedRevision: 0, options: f.options },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: 'APPLICATION_POLICY_UNAVAILABLE' });
  expect(loadLedger(f.m)).toEqual([]);
  expect(readFileSync(f.selectionPath, 'utf8')).toBe(before);
});
