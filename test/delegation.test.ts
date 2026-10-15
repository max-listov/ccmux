import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareManagedCodexTurn } from '../src/agent/codex/appServer.ts';
import { stableJson } from '../src/agent/launch/launchInputs.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import type { ControlCreate } from '../src/control/schema/session.ts';
import { delegationStopped, stopDelegationRequest } from '../src/delegation/cancel.ts';
import { delegatedClaudeOptions } from '../src/delegation/claude.ts';
import {
  assertDelegatedCodexAcknowledgement,
  delegatedCodexPolicy,
} from '../src/delegation/codex.ts';
import { narrowPolicy, resolveDelegation } from '../src/delegation/resolve.ts';
import { type DelegatedPolicy, DelegationSchema } from '../src/delegation/schema.ts';
import type { CreateManagedInput } from '../src/session/create.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-delegation-test-'));
  roots.push(root);
  const parent = makeSession({
    name: 'parent',
    dir: root,
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
  });
  const policy: DelegatedPolicy = {
    access: 'read-only',
    readScope: 'host',
    workspace: root,
    network: false,
  };
  const reference = {
    target: managedPeer('host-a', parent),
    registrationGeneration: parent.registrationGeneration ?? crypto.randomUUID(),
  };
  const m = makeMachine({
    stateDir: join(root, 'state'),
    rcPrefix: 'host-a',
    delegationAuthorities: [{ parent: reference, policy }],
  });
  return { root, parent, policy, reference, m };
}
test('authority is exact, narrowing refuses writes and workspace escape before executor admission', async () => {
  const f = fixture();
  await writeSessionsUnlocked(f.m, [f.parent]);
  expect(
    resolveDelegation(f.m, 'codex', 'app-server', f.root, crypto.randomUUID(), {
      parent: f.reference,
      policy: f.policy,
    }).policy,
  ).toEqual(f.policy);
  for (const access of ['workspace-write', 'full-access'] satisfies DelegatedPolicy['access'][])
    expect(() =>
      resolveDelegation(f.m, 'codex', 'app-server', f.root, crypto.randomUUID(), {
        parent: f.reference,
        policy: { ...f.policy, access },
      }),
    ).toThrow('exceeds parent authority');
  expect(() => narrowPolicy(f.policy, { ...f.policy, workspace: '/' })).toThrow(
    'exceeds parent authority',
  );
  expect(() =>
    resolveDelegation(
      { ...f.m, delegationAuthorities: [] },
      'codex',
      'app-server',
      f.root,
      crypto.randomUUID(),
      { parent: f.reference, policy: f.policy },
    ),
  ).toThrow('not declared');
  expect(() =>
    resolveDelegation(f.m, 'codex', 'app-server', f.root, crypto.randomUUID(), {
      parent: { ...f.reference, registrationGeneration: crypto.randomUUID() },
      policy: f.policy,
    }),
  ).toThrow('registration');
  let calls = 0;
  await expect(
    createControlSession(
      f.m,
      {
        runtime: 'claude',
        mode: 'native',
        name: 'child',
        workspace: f.root,
        requestId: crypto.randomUUID(),
        delegation: { parent: f.reference, policy: { ...f.policy, access: 'workspace-write' } },
      },
      new AbortController().signal,
      async () => {
        calls++;
        return f.parent;
      },
    ),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
  expect(calls).toBe(0);
  expect(loadSessions(f.m)).toHaveLength(1);
});
test('native acknowledgement must match the actual sandbox, not the requested label', () => {
  const f = fixture();
  const delegation = DelegationSchema.parse({
    parent: f.reference,
    policy: f.policy,
    requestId: crypto.randomUUID(),
    policyDigest: createHash('sha256').update(stableJson(f.policy)).digest('hex'),
  });
  const s = makeSession({ agent: 'codex', runtime: 'app-server', dir: f.root, delegation });
  expect(delegatedCodexPolicy(s)).toEqual({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
  expect(() =>
    assertDelegatedCodexAcknowledgement(s, {
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
    }),
  ).not.toThrow();
  for (const raw of [
    { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } },
    { approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: true } },
    { approvalPolicy: 'onRequest', sandbox: { type: 'readOnly' } },
  ])
    expect(() => assertDelegatedCodexAcknowledgement(s, raw)).toThrow('Provider');
});
test('Claude removes inherited side effects and its pre-tool hook refuses writes even in bypass mode', async () => {
  const f = fixture();
  const delegation = DelegationSchema.parse({
    parent: f.reference,
    policy: f.policy,
    requestId: crypto.randomUUID(),
    policyDigest: createHash('sha256').update(stableJson(f.policy)).digest('hex'),
  });
  const options = delegatedClaudeOptions(
    makeSession({ agent: 'claude', runtime: 'native', dir: f.root, delegation }),
  );
  expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
  expect(options.settingSources).toEqual([]);
  expect(options.mcpServers).toEqual({});
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw Error('missing enforcement hook');
  for (const tool of ['Read', 'Write', 'Bash', 'Agent', 'mcp__other__write']) {
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: crypto.randomUUID(),
        transcript_path: '/tmp/transcript',
        cwd: f.root,
        tool_name: tool,
        tool_input: {},
        tool_use_id: 'call',
      },
      'call',
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: tool === 'Read' ? 'allow' : 'deny' },
    });
  }
});
test('accepted delegation and request correlation survive identical retries; changed policy is refused', async () => {
  const f = fixture();
  await writeSessionsUnlocked(f.m, [f.parent]);
  let calls = 0;
  const request: ControlCreate = {
    runtime: 'codex',
    mode: 'native',
    requestId: crypto.randomUUID(),
    name: 'child',
    workspace: f.root,
    delegation: { parent: f.reference, policy: f.policy },
  };
  const create = async (_m: typeof f.m, input: CreateManagedInput) => {
    calls++;
    const child = makeSession({
      name: input.name,
      dir: input.dir,
      agent: input.agent,
      runtime: input.runtime,
      registrationGeneration: input.registrationGeneration,
      delegation: input.delegation,
    });
    await writeSessionsUnlocked(f.m, [f.parent, child]);
    return child;
  };
  const first = await createControlSession(f.m, request, new AbortController().signal, create);
  const retry = await createControlSession(f.m, request, new AbortController().signal, create);
  expect(calls).toBe(1);
  expect(retry.duplicate).toBe(true);
  expect(retry.target).toEqual(first.target);
  expect(retry.delegation?.delegation.requestId).toBe(request.requestId);
  await expect(
    createControlSession(
      f.m,
      { ...request, name: 'changed' },
      new AbortController().signal,
      create,
    ),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

test('expired host authority and inherited deadlines refuse admission before any model turn', async () => {
  const f = fixture();
  await writeSessionsUnlocked(f.m, [f.parent]);
  f.m.delegationAuthorities = [
    {
      parent: f.reference,
      policy: f.policy,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    },
  ];
  expect(() =>
    resolveDelegation(f.m, 'codex', 'app-server', f.root, crypto.randomUUID(), {
      parent: f.reference,
      policy: f.policy,
    }),
  ).toThrow('deadline has expired');
  const delegation = DelegationSchema.parse({
    parent: f.reference,
    policy: f.policy,
    requestId: crypto.randomUUID(),
    policyDigest: createHash('sha256').update(stableJson(f.policy)).digest('hex'),
  });
  const s = makeSession({ agent: 'codex', runtime: 'app-server', dir: f.root, delegation });
  stopDelegationRequest(f.m, delegation.requestId, crypto.randomUUID(), 'create-aborted');
  expect(delegationStopped(f.m, s)).toBe(true);
  let calls = 0;
  await expect(
    prepareManagedCodexTurn(
      {
        request: async () => {
          calls++;
          return null;
        },
        close() {},
      },
      f.m,
      s,
      {
        thread: {
          id: s.uuid,
          name: null,
          source: null,
          status: { type: 'idle' },
          canAcceptDirectInput: true,
          turns: [],
        },
        model: 'test',
        modelProvider: 'openai',
      },
    ),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
  expect(calls).toBe(0);
});
