import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepareManagedCodexTurn } from '../src/agent/codex/appServer.ts';
import { ownedCodexArgv, ownedCodexThreadParams } from '../src/agent/codex/owned/launch.ts';
import { verifyManagedLaunchRecipe } from '../src/config/launchRecipes.ts';
import { validateModelSelection } from '../src/config/modelSelection.ts';
import { requestLockPath, storeLockPath } from '../src/control/createReceipts.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlCreateSchema } from '../src/control/schema/session.ts';
import { privateRuntimeDirectory } from '../src/runtime/store.ts';
import type { CreateManagedInput } from '../src/session/create.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { withLock } from '../src/util/lock.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('one profile serves two model selections; retries and restart preserve one writer and selection', async () => {
  const root = mkdtempSync('/tmp/ccmux-selection-test-');
  const machine = makeMachine({
    stateDir: join(root, 'state'),
    codexBin: '/bin/codex',
    launchRecipes: {
      generic: {
        revision: '1',
        flags: [],
        environment: [],
        capabilities: ['input-requests'],
        collaborationMode: 'plan',
      },
    },
  });
  let spawns = 0;
  const create = async (_machine: typeof machine, input: CreateManagedInput) => {
    spawns++;
    const session = makeSession({
      ...input,
      uuid: crypto.randomUUID(),
      dir: input.dir,
      registrationGeneration: input.registrationGeneration,
      agent: 'codex',
      runtime: 'app-server',
    });
    await writeSessionsUnlocked(machine, [...loadSessions(machine), session]);
    return session;
  };
  let validations = 0;
  const validate = async () => {
    validations++;
  };
  const input = {
    requestId: crypto.randomUUID(),
    name: 'model-a',
    workspace: root,
    flags: [],
    launchRecipe: { id: 'generic', revision: '1' },
    modelSelection: { provider: 'openai', model: 'model-a' },
  };
  try {
    const first = await createControlSession(
      machine,
      input,
      AbortSignal.timeout(3_000),
      create,
      validate,
    );
    const retry = await createControlSession(
      { ...machine },
      input,
      AbortSignal.timeout(3_000),
      create,
      validate,
    );
    expect(retry.target).toEqual(first.target);
    expect(retry.modelSelection).toEqual(input.modelSelection);
    expect(retry.duplicate).toBe(true);
    expect(validations).toBe(1);
    await expect(
      createControlSession(
        machine,
        { ...input, modelSelection: { provider: 'openai', model: 'model-b' } },
        AbortSignal.timeout(3_000),
        create,
        validate,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const second = await createControlSession(
      machine,
      {
        ...input,
        requestId: crypto.randomUUID(),
        name: 'model-b',
        modelSelection: { provider: 'openai', model: 'model-b' },
      },
      AbortSignal.timeout(3_000),
      create,
      validate,
    );
    expect(second.launchRecipe?.digest).toBe(first.launchRecipe?.digest);
    expect(spawns).toBe(2);
    for (const session of loadSessions(machine)) {
      verifyManagedLaunchRecipe(machine, session);
      expect(ownedCodexThreadParams(session, machine)).toMatchObject({
        model: session.modelSelection?.model,
        modelProvider: 'openai',
      });
      expect(ownedCodexArgv(session, machine)).toContain(
        `model="${session.modelSelection?.model}"`,
      );
    }
    const count = loadSessions(machine).length;
    await expect(
      createControlSession(
        machine,
        { ...input, requestId: crypto.randomUUID() },
        AbortSignal.timeout(3_000),
        create,
        async () => {
          throw new Error('unsupported model');
        },
      ),
    ).rejects.toThrow('unsupported model');
    expect(loadSessions(machine)).toHaveLength(count);
    expect(spawns).toBe(2);
    await expect(
      createControlSession(
        machine,
        { ...input, flags: ['-m', 'other'] },
        AbortSignal.timeout(3_000),
        create,
        validate,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      ControlCreateSchema.safeParse({
        ...input,
        modelSelection: { ...input.modelSelection, endpoint: 'https://example.invalid' },
      }).success,
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('model validation cannot create a provider or infer an unsupported selection', async () => {
  const machine = makeMachine({ codexBin: undefined, codexHome: undefined });
  await expect(
    validateModelSelection(
      machine,
      { flags: [] },
      '/work',
      { provider: 'openai', model: 'model-a' },
      AbortSignal.timeout(1_000),
    ),
    // The refusal names the value it refused: a message that said only which FIELD was wrong sent
    // a consumer looking for a malformed request twice, when the request was fine.
  ).rejects.toMatchObject({
    code: 'MODEL_UNAVAILABLE',
    message: 'Model openai/model-a is unavailable',
  });
});

test('a loaded provider mismatch is refused before collaboration discovery or turn submission', async () => {
  const session = makeSession({ modelSelection: { provider: 'openai', model: 'model-a' } });
  let reads = 0;
  const rpc = {
    close() {},
    async request() {
      reads++;
      return {};
    },
  };
  await expect(
    prepareManagedCodexTurn(rpc, makeMachine(), session, {
      thread: {
        id: session.uuid,
        name: session.name,
        source: 'appServer',
        status: { type: 'idle' },
        canAcceptDirectInput: true,
        turns: [],
      },
      model: 'model-a',
      modelProvider: 'other-provider',
    }),
  ).rejects.toMatchObject({ code: 'COLLABORATION_MODE_UNAVAILABLE' });
  expect(reads).toBe(0);
});

test("a create waiting for a held request lock ends at the caller's deadline, not the lock's", async () => {
  const root = mkdtempSync('/tmp/ccmux-selection-lock-');
  const machine = makeMachine({ stateDir: join(root, 'state'), codexBin: '/bin/codex' });
  const requestId = crypto.randomUUID();
  privateRuntimeDirectory(dirname(storeLockPath(machine)));
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const holder = withLock(
    requestLockPath(machine, requestId),
    async () => {
      entered.resolve();
      await held.promise;
    },
    'test holder',
  );
  try {
    await entered.promise;
    const started = performance.now();
    await expect(
      createControlSession(
        machine,
        { requestId, name: 'held', workspace: root, flags: [] },
        AbortSignal.timeout(200),
        async () => {
          throw new Error('a create behind a held lock must not reach the provider');
        },
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    // The lock's own bound is ten seconds; the caller's is 200 ms.
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally {
    held.resolve();
    await holder;
    rmSync(root, { recursive: true, force: true });
  }
});
