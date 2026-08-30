import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareManagedCodexTurn } from '../src/agent/codex/appServer.ts';
import { ownedCodexArgv, ownedCodexThreadParams } from '../src/agent/codex/ownedLaunch.ts';
import type { CreateManagedInput } from '../src/commands/create.ts';
import { verifyManagedLaunchRecipe } from '../src/config/launchRecipes.ts';
import { validateModelSelection } from '../src/config/modelSelection.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/config/sessions.ts';
import { createControlSession } from '../src/control/lifecycle.ts';
import { ControlCreateSchema } from '../src/control/schema.ts';
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
  ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: 'Selected model is unavailable' });
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
