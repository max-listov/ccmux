import { afterEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import type { MockLanguageModelV4 } from 'ai/test';
import { CustomLaunchConfigSchema } from '../src/agent/custom/config.ts';
import { prepareCustomHost } from '../src/agent/custom/host.ts';
import { resolveControlLaunchRecipe } from '../src/config/launchRecipes.ts';
import { MachineLaunchRecipeSchema } from '../src/config/schema.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
export async function customFixture(
  configure?: (
    root: string,
    config: ReturnType<typeof CustomLaunchConfigSchema.parse>,
  ) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccmux-custom-engine-')));
  roots.push(root);
  const envFile = join(root, 'declared.env');
  await writeFile(
    envFile,
    'FIXTURE_PROVIDER_KEY=secret-like-provider-fixture\nFIXTURE_APPROVAL_KEY=secret-like-approval-fixture-long-enough\n',
    { mode: 0o600 },
  );
  const custom = CustomLaunchConfigSchema.parse({
    provider: { kind: 'openrouter', credentialEnv: 'FIXTURE_PROVIDER_KEY' },
    models: [
      {
        selection: { provider: 'openrouter', model: 'fixture/model' },
        contextWindow: 8192,
        capabilities: ['tools'],
      },
    ],
    defaultModel: { provider: 'openrouter', model: 'fixture/model' },
    resources: [],
    trustedRoots: [],
    tools: ['write_file'],
    approvalTools: ['write_file'],
    approvalSecretEnv: 'FIXTURE_APPROVAL_KEY',
    executables: {},
    commandEnvironment: [],
  });
  await configure?.(root, custom);
  const m = makeMachine({
    stateDir: root,
    launchRecipes: {
      coding: MachineLaunchRecipeSchema.parse({ revision: 'one', envFile, custom }),
    },
  });
  const launch = resolveControlLaunchRecipe(
    m,
    root,
    { id: 'coding', revision: 'one' },
    [],
    'custom',
  );
  const s = makeSession({
    name: 'custom-fixture',
    dir: root,
    agent: 'custom',
    runtime: 'native',
    registrationGeneration: randomUUID(),
    nativeSession: { runtime: 'custom', id: randomUUID(), version: '0.70.1' },
    ...launch,
  });
  const host = prepareCustomHost(m, s);
  return { root, m, s, host };
}
export const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
export const textStream = (): Awaited<ReturnType<MockLanguageModelV4['doStream']>> => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'complete' },
      { type: 'text-end', id: 'a' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage,
      },
    ],
  }),
});
