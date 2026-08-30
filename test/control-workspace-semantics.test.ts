import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateManagedInput } from '../src/commands/create.ts';
import { appendSession, loadSessions } from '../src/config/sessions.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlCreateSchema } from '../src/control/schema.ts';
import { controlTarget } from '../src/control/target.ts';
import type { MachineConfig } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-workspace-contract-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const machine = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
  let launches = 0;
  const create = async (_machine: MachineConfig, input: CreateManagedInput) => {
    launches++;
    const session = makeSession({
      name: input.name,
      dir: input.dir,
      agent: input.agent,
      runtime: input.runtime,
      uuid: crypto.randomUUID(),
      registrationGeneration: input.registrationGeneration,
    });
    await appendSession(machine, session);
    return session;
  };
  const start = (input: unknown) =>
    createControlSession(
      machine,
      ControlCreateSchema.parse(input),
      AbortSignal.timeout(5000),
      create,
    );
  return { machine, workspace, start, launches: () => launches };
}

test('non-Git workspace create and normalized retry preserve one exact registration', async () => {
  const f = fixture();
  expect(existsSync(join(f.workspace, '.git'))).toBe(false);
  const input = { requestId: crypto.randomUUID(), name: 'worker-a', workspace: f.workspace };
  const first = await f.start(input);
  const retry = await f.start({ ...input, workspace: `${f.workspace}/.` });
  expect(first.workspace).toBe(f.workspace);
  expect(retry.target).toEqual(first.target);
  expect(retry.registrationGeneration).toBe(first.registrationGeneration);
  expect(retry.duplicate).toBe(true);
  expect(f.launches()).toBe(1);
  expect(loadSessions(f.machine)).toHaveLength(1);

  const other = join(f.workspace, 'other');
  mkdirSync(other);
  await expect(f.start({ ...input, workspace: other })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(f.launches()).toBe(1);
});

test('shared workspace does not merge registrations or authorize another session identity', async () => {
  const f = fixture();
  const [first, second] = await Promise.all(
    ['worker-a', 'worker-b'].map((name) =>
      f.start({ requestId: crypto.randomUUID(), name, workspace: f.workspace }),
    ),
  );
  assert(first && second);
  expect(first.workspace).toBe(second.workspace);
  expect(first.target.threadId).not.toBe(second.target.threadId);
  expect(first.registrationGeneration).not.toBe(second.registrationGeneration);
  expect(f.launches()).toBe(2);
  expect(loadSessions(f.machine)).toHaveLength(2);
  expect(controlTarget(f.machine, first.target).name).toBe('worker-a');
  expect(controlTarget(f.machine, second.target).name).toBe('worker-b');
  expect(() =>
    controlTarget(f.machine, { ...first.target, threadId: second.target.threadId }),
  ).toThrow('The exact managed session is unavailable');
});

test('create refuses product or repository membership claims rather than interpreting them', () => {
  const input = {
    requestId: crypto.randomUUID(),
    name: 'worker-a',
    workspace: '/tmp/workspace',
  };
  expect(ControlCreateSchema.safeParse(input).success).toBe(true);
  for (const field of ['projectId', 'repositoryId', 'checkoutId', 'harnessWorkspaceId']) {
    expect(ControlCreateSchema.safeParse({ ...input, [field]: 'example-id' }).success).toBe(false);
  }
});
