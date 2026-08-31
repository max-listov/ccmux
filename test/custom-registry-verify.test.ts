import { expect, test } from 'bun:test';
import { CustomLaunchConfigSchema } from '../src/agent/custom/config.ts';
import {
  compareRegistry,
  registrySettled,
  verdictLines,
  verifyCustomRegistry,
} from '../src/agent/custom/verify.ts';

const config = (
  models: { model: string; contextWindow: number }[],
  provider: Record<string, unknown> = { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1' },
) =>
  CustomLaunchConfigSchema.parse({
    provider,
    models: models.map(({ model, contextWindow }) => ({
      selection: { provider: provider.kind, model },
      contextWindow,
      capabilities: [],
    })),
    defaultModel: { provider: provider.kind, model: models[0]?.model },
    trustedRoots: [],
    resources: [],
    tools: [],
    approvalTools: [],
    approvalSecretEnv: 'FIXTURE_APPROVAL_KEY',
    executables: {},
    commandEnvironment: [],
  });

const serve = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

test('a model the server does not list is missing, and one it lists is served', () => {
  const declared = config([
    { model: 'a/one', contextWindow: 8192 },
    { model: 'a/two', contextWindow: 8192 },
  ]);
  const verdicts = compareRegistry(declared, [{ id: 'a/one' }]);
  expect(verdicts.map(({ model, served }) => [model, served])).toEqual([
    ['a/one', 'yes'],
    ['a/two', 'no'],
  ]);
});

test('an unreachable provider makes every model unknown, never missing', () => {
  // The whole point of the check. Collapsing "we could not look" into "it is not there" would
  // report a registry as broken every time the model server happened to be off.
  const verdicts = compareRegistry(config([{ model: 'a/one', contextWindow: 8192 }]), null);
  expect(verdicts[0]).toMatchObject({ served: 'unknown', context: 'unverified' });
});

test('a context window the server never published stays declared and unverified', () => {
  // Most OpenAI-compatible listings carry no context length at all. Silence is not agreement and it
  // is not contradiction; calling it either would invent a fact the server did not state.
  const verdicts = compareRegistry(config([{ model: 'a/one', contextWindow: 8192 }]), [
    { id: 'a/one' },
  ]);
  expect(verdicts[0]).toMatchObject({ context: 'unverified', servedContextWindow: null });
});

test('only a declared window LARGER than the served one is a contradiction', () => {
  // A host may deliberately declare less than the server supports — that is a budget choice, not an
  // error. Declaring more is a prompt the server cannot honour, and that is worth a red word.
  const smaller = compareRegistry(config([{ model: 'a/one', contextWindow: 8192 }]), [
    { id: 'a/one', max_context_length: 32768 },
  ]);
  expect(smaller[0]?.context).toBe('agrees');
  const larger = compareRegistry(config([{ model: 'a/one', contextWindow: 131072 }]), [
    { id: 'a/one', max_context_length: 32768 },
  ]);
  expect(larger[0]).toMatchObject({
    context: 'declared-exceeds-served',
    servedContextWindow: 32768,
  });
});

test('the aggregator is reported as not queryable by this check, with the reason', async () => {
  // Not silently skipped and not called unreachable: an aggregator has a catalog, reached by its own
  // API, and this check reads an OpenAI-compatible model list. Saying so is the honest answer.
  const verdict = await verifyCustomRegistry(
    config([{ model: 'a/one', contextWindow: 8192 }], {
      kind: 'openrouter',
      credentialEnv: 'KEY',
    }),
    'secret',
    serve({ data: [] }),
  );
  expect(verdict.probe).toBe('not-queryable');
  expect(verdict.reason).toContain('OpenAI-compatible model list');
  expect(verdict.models[0]?.served).toBe('unknown');
  expect(registrySettled(verdict)).toBe(false);
});

test('a reachable local endpoint settles a registry it fully serves', async () => {
  const verdict = await verifyCustomRegistry(
    config([{ model: 'a/one', contextWindow: 8192 }]),
    undefined,
    serve({ data: [{ id: 'a/one', max_context_length: 8192 }] }),
  );
  expect(verdict).toMatchObject({ probe: 'reached', reason: null });
  expect(registrySettled(verdict)).toBe(true);
});

test('an HTTP refusal and a nonsense body are both unreachable, each saying which', async () => {
  const refused = await verifyCustomRegistry(
    config([{ model: 'a/one', contextWindow: 8192 }]),
    undefined,
    serve({ error: 'nope' }, 503),
  );
  expect(refused).toMatchObject({ probe: 'unreachable' });
  expect(refused.reason).toContain('503');

  const nonsense = await verifyCustomRegistry(
    config([{ model: 'a/one', contextWindow: 8192 }]),
    undefined,
    serve({ models: ['a/one'] }),
  );
  expect(nonsense).toMatchObject({ probe: 'unreachable' });
  expect(nonsense.reason).toContain('OpenAI-compatible');
});

test('a connection that throws is unreachable and carries its own message', async () => {
  const verdict = await verifyCustomRegistry(
    config([{ model: 'a/one', contextWindow: 8192 }]),
    undefined,
    (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch,
  );
  expect(verdict).toMatchObject({ probe: 'unreachable', reason: 'connection refused' });
  expect(verdict.models.every((model) => model.served === 'unknown')).toBe(true);
});

test('the printed report says what was checked, not only whether it passed', () => {
  const lines = verdictLines({
    provider: 'local',
    providerLabel: 'lm-studio',
    probe: 'reached',
    reason: null,
    models: [
      {
        model: 'a/one',
        served: 'yes',
        declaredContextWindow: 131072,
        servedContextWindow: 32768,
        context: 'declared-exceeds-served',
      },
      {
        model: 'a/two',
        served: 'no',
        declaredContextWindow: 8192,
        servedContextWindow: null,
        context: 'unverified',
      },
    ],
  });
  expect(lines[0]).toContain('lm-studio');
  expect(lines[1]).toContain('EXCEEDS SERVED 32768');
  expect(lines[2]).toContain('NOT SERVED');
  expect(lines[2]).toContain('not published by the server');
});
