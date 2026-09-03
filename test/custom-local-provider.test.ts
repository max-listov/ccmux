import { expect, test } from 'bun:test';
import { readCustomModels } from '../src/agent/custom/catalog.ts';
import { CustomLaunchConfigSchema } from '../src/agent/custom/config.ts';
import { isLocalAddress, parseLocalEndpoint } from '../src/agent/custom/endpoint.ts';
import { customModel, customProviderLabel } from '../src/agent/custom/host.ts';
import { ControlModelsReadSchema } from '../src/control/schema.ts';
import { customFixture as fixture } from './custom-fixture.ts';

const LOCAL_MODEL = { provider: 'local', model: 'local/fixture' } as const;

/** A host whose provider is a model server on this machine, not the aggregator. */
const localFixture = (
  endpoint = 'http://127.0.0.1:1234/v1',
  credentialEnv?: string,
  models = [
    { selection: { ...LOCAL_MODEL }, contextWindow: 8192, capabilities: ['tools' as const] },
  ],
) =>
  fixture(async (_root, config) => {
    config.provider = {
      kind: 'local',
      endpoint,
      ...(credentialEnv === undefined ? {} : { credentialEnv }),
    };
    config.models = models;
    config.defaultModel = { ...LOCAL_MODEL };
  });

test('locality is decided from the address, so a public endpoint cannot be called local', () => {
  // The catalog publishes the word `local` as the provenance of an answer. If any URL could carry
  // that word, the one thing the kind asserts — the prompt did not leave the host or its network —
  // would be unverifiable exactly when it matters.
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.10', '172.16.0.1', '[::1]'])
    expect(isLocalAddress(host)).toBe(true);
  for (const host of ['api.example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '[2606:4700::1]'])
    expect(isLocalAddress(host)).toBe(false);
});

test('a /12 boundary is compared as an address, not as a leading octet', () => {
  // 172.16.0.0/12 ends mid-octet: 172.31.255.255 is private and 172.32.0.1 is public, and both
  // begin with the same number. Comparing octets by eye is what makes a public host look private.
  expect(isLocalAddress('172.31.255.255')).toBe(true);
  expect(isLocalAddress('172.32.0.1')).toBe(false);
  expect(isLocalAddress('172.15.255.255')).toBe(false);
});

test('each endpoint refusal names its own reason', () => {
  // A single "invalid endpoint" would make four different configuration mistakes look alike.
  expect(parseLocalEndpoint('not a url')).toEqual({ refused: 'not-a-url' });
  expect(parseLocalEndpoint('ftp://127.0.0.1/v1')).toEqual({ refused: 'protocol' });
  expect(parseLocalEndpoint('http://user:pass@127.0.0.1/v1')).toEqual({
    refused: 'embedded-credentials',
  });
  expect(parseLocalEndpoint('http://127.0.0.1/v1?key=secret')).toEqual({
    refused: 'query-or-fragment',
  });
  expect(parseLocalEndpoint('https://api.example.com/v1')).toEqual({ refused: 'not-local' });
  const accepted = parseLocalEndpoint('http://127.0.0.1:1234/v1');
  expect('url' in accepted && accepted.url.port).toBe('1234');
});

test('the host config accepts a local provider and still accepts the aggregator unchanged', async () => {
  const { host } = await localFixture();
  expect(host.config.provider).toEqual({ kind: 'local', endpoint: 'http://127.0.0.1:1234/v1' });
  // Absence of a declared credential env is the local case, not a missing value.
  expect(host.credential).toBeUndefined();
  expect(host.approvalSecret.length).toBeGreaterThanOrEqual(32);

  const { host: aggregator } = await fixture();
  expect(aggregator.config.provider).toEqual({
    kind: 'openrouter',
    credentialEnv: 'FIXTURE_PROVIDER_KEY',
  });
  expect(aggregator.credential).toBe('secret-like-provider-fixture');
});

test('a local provider may declare a credential, and then it is required like any other', async () => {
  const { host } = await localFixture('http://127.0.0.1:1234/v1', 'FIXTURE_PROVIDER_KEY');
  expect(host.credential).toBe('secret-like-provider-fixture');
  await expect(localFixture('http://127.0.0.1:1234/v1', 'FIXTURE_ABSENT_KEY')).rejects.toThrow(
    'unavailable',
  );
});

test('a non-local endpoint is refused by configuration, before any host is prepared', async () => {
  // The recipe is rejected where it is defined. Reaching a provider call to discover this would
  // mean the prompt had already been built for an endpoint the runtime should never have accepted.
  await expect(localFixture('https://api.example.com/v1')).rejects.toThrow();
  await expect(localFixture('http://user:pass@127.0.0.1/v1')).rejects.toThrow();
});

test('a model must declare the provider that will serve it', () => {
  // Otherwise the registry would hold a model no adapter answers for, and the mismatch would
  // surface as an unresolved provider at the first turn instead of as invalid configuration.
  const parse = (provider: string) =>
    CustomLaunchConfigSchema.safeParse({
      provider: { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1' },
      models: [
        { selection: { provider, model: 'local/fixture' }, contextWindow: 8192, capabilities: [] },
      ],
      defaultModel: { provider, model: 'local/fixture' },
      trustedRoots: [],
      resources: [],
      tools: [],
      approvalTools: [],
      approvalSecretEnv: 'FIXTURE_APPROVAL_KEY',
      executables: {},
      commandEnvironment: [],
    });
  expect(parse('local').success).toBe(true);
  const mismatched = parse('openrouter');
  expect(mismatched.success).toBe(false);
  expect(JSON.stringify(mismatched.error?.issues)).toContain('Model provider must match');
});

test('the catalog reports the local provider as the source, for the page and for each model', async () => {
  const { m } = await localFixture();
  const catalog = readCustomModels(
    m,
    ControlModelsReadSchema.parse({ launchRecipe: { id: 'coding', revision: 'one' } }),
  );
  expect(catalog.source.provider).toBe('local');
  expect(catalog.source.runtime).toBe('custom');
  expect(catalog.data).toHaveLength(1);
  expect(catalog.data[0]?.provider).toBe('local');
  expect(catalog.data[0]?.isDefault).toBe(true);
  // The endpoint is host configuration and stays there; a catalog reader learns the provenance,
  // never the address or any credential.
  expect(JSON.stringify(catalog)).not.toContain('127.0.0.1');
  expect(JSON.stringify(catalog)).not.toContain('secret-like');
});

test('an unsupported selection is refused before anything is submitted to a provider', async () => {
  const { host } = await localFixture();
  expect(customModel(host.config, { ...LOCAL_MODEL })).toMatchObject({ contextWindow: 8192 });
  // Same model name, different provider: this is the reroute the runtime must not perform silently.
  // The refusal names the pair it refused, so the two cases below are told apart by reading it —
  // a message that said only "unavailable" left the caller guessing which half was wrong.
  expect(() =>
    customModel(host.config, { provider: 'openrouter', model: 'local/fixture' }),
  ).toThrow('Model openrouter/local/fixture is not one this host declares');
  expect(() => customModel(host.config, { provider: 'local', model: 'local/absent' })).toThrow(
    'Model local/local/absent is not one this host declares',
  );
});

test('a host may name the server behind the local kind, and it travels beside the locality fact', async () => {
  // `local` says the address was checked; it cannot say which engine answered, so a host running two
  // reports the same provenance for both. The label carries that half without weakening the other.
  const { m, host } = await fixture(async (_root, config) => {
    config.provider = { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1', label: 'lm-studio' };
    config.models = [
      { selection: { ...LOCAL_MODEL }, contextWindow: 8192, capabilities: ['tools'] },
    ];
    config.defaultModel = { ...LOCAL_MODEL };
  });
  expect(customProviderLabel(host.config)).toBe('lm-studio');
  const catalog = readCustomModels(
    m,
    ControlModelsReadSchema.parse({ launchRecipe: { id: 'coding', revision: 'one' } }),
  );
  expect(catalog.source.provider).toBe('local');
  expect(catalog.source.providerLabel).toBe('lm-studio');
  // Still not part of identity: selection matches on provider and model, and the label is neither.
  expect(catalog.data[0]?.provider).toBe('local');
  expect(customModel(host.config, { ...LOCAL_MODEL })).toMatchObject({ contextWindow: 8192 });
  expect(JSON.stringify(catalog)).not.toContain('127.0.0.1');
});

test('a host that names nothing keeps exactly the previous answer', async () => {
  const { m, host } = await localFixture();
  expect(customProviderLabel(host.config)).toBeNull();
  const catalog = readCustomModels(
    m,
    ControlModelsReadSchema.parse({ launchRecipe: { id: 'coding', revision: 'one' } }),
  );
  expect(catalog.source.providerLabel).toBeNull();
});

test('the aggregator has no server label to give', async () => {
  // The label belongs to the local kind, where "which server" is a real question. An aggregator is
  // already named by its kind, so inventing a second name there would be noise, not provenance.
  const { host } = await fixture();
  expect(customProviderLabel(host.config)).toBeNull();
  const parsed = CustomLaunchConfigSchema.safeParse({
    provider: { kind: 'openrouter', credentialEnv: 'FIXTURE_PROVIDER_KEY', label: 'anything' },
    models: [
      {
        selection: { provider: 'openrouter', model: 'a/b' },
        contextWindow: 8192,
        capabilities: [],
      },
    ],
    defaultModel: { provider: 'openrouter', model: 'a/b' },
    trustedRoots: [],
    resources: [],
    tools: [],
    approvalTools: [],
    approvalSecretEnv: 'FIXTURE_APPROVAL_KEY',
    executables: {},
    commandEnvironment: [],
  });
  expect(parsed.success).toBe(false);
});

test('a label is a name, not free text', async () => {
  // It is host configuration pinned by the recipe digest rather than caller input, so the charset is
  // the whole guard needed — but it still has to be a name, because readers will display it.
  const build = (label: string) =>
    CustomLaunchConfigSchema.safeParse({
      provider: { kind: 'local', endpoint: 'http://127.0.0.1:1234/v1', label },
      models: [{ selection: { ...LOCAL_MODEL }, contextWindow: 8192, capabilities: [] }],
      defaultModel: { ...LOCAL_MODEL },
      trustedRoots: [],
      resources: [],
      tools: [],
      approvalTools: [],
      approvalSecretEnv: 'FIXTURE_APPROVAL_KEY',
      executables: {},
      commandEnvironment: [],
    }).success;
  // Real engines are named with dots and hyphens, so those belong in a name: refusing `llama.cpp`
  // would push the host into inventing a spelling nobody uses.
  expect(build('lm-studio')).toBe(true);
  expect(build('llama.cpp')).toBe(true);
  expect(build('vllm_1')).toBe(true);
  // Display text, a path, or anything a reader could mistake for an address is not a name.
  expect(build('LM Studio')).toBe(false);
  expect(build('http://127.0.0.1:1234')).toBe(false);
  expect(build('-leading')).toBe(false);
  expect(build('')).toBe(false);
});
