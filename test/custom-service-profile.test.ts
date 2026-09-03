import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import {
  CustomLaunchConfigSchema,
  declaredCustomToolNames,
  MAX_DECLARED_CUSTOM_TOOLS,
} from '../src/agent/custom/config.ts';
import { openCustomEngine } from '../src/agent/custom/engine.ts';
import { CustomProfile } from '../src/agent/custom/profile.ts';
import { RuntimeAppliedProfileSchema } from '../src/policy/runtimeProfile.ts';
import { customFixture, textStream } from './custom-fixture.ts';
import { clearServiceFixtures, stdioService, TASKS } from './service-fixture.ts';

afterEach(() => clearServiceFixtures());

test('a session declaring a service survives the profile its own composition produced', async () => {
  const { root, s, host } = await customFixture(async (_root, config) => {
    config.services.push({ id: 'tasks', ...stdioService(TASKS), tools: ['claim__task'] });
  });
  const profile = new CustomProfile(join(root, 'engine'), s, host);
  const applied: Awaited<ReturnType<CustomProfile['applied']>>[] = [];
  const refused: string[] = [];
  const engine = await openCustomEngine({
    root: join(root, 'engine'),
    session: s,
    host,
    provider: { create: () => new MockLanguageModelV4({ doStream: textStream() }) },
    publish: () => undefined,
    onError: (error) => {
      throw error;
    },
    onProfile: async (event) => {
      // Caught rather than thrown so a refusal arrives as its own sentence: the harness reports a
      // failing profile handler through `onProfileError`, and the assertion would otherwise read
      // «no profile was applied» for a defect whose whole content is why it was refused.
      try {
        applied.push(await profile.applied(event));
      } catch (error) {
        refused.push(error instanceof Error ? error.message : String(error));
      }
    },
  });
  try {
    const ticket = engine.harness.submit({
      conversationId: engine.conversationId,
      context: engine.context,
      idempotencyKey: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'claim one' }],
      metadata: {
        registration: s.registrationGeneration,
        messageId: crypto.randomUUID(),
        recipeDigest: s.launchRecipe?.digest,
        model: host.config.defaultModel,
      },
    });
    await ticket.result;
    // The operation the recipe declared is in the profile the harness applied, and the check that
    // reads that profile knows it: composition admitted the name from `services[].tools`, so a
    // check reading `tools` alone refused every session that declared any service at all.
    expect(refused).toEqual([]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.tools).toContain('claim__task');
    expect(applied[0]?.tools).toContain('write_file');
    expect(await profile.read(engine)).toEqual(applied[0] ?? null);
  } finally {
    await engine.close();
  }
}, 30_000);

test('the retained profile admits every name the largest valid recipe can declare', async () => {
  // The bound downstream of composition is the same defect one layer along: a recipe the config
  // schema accepts must produce a profile the profile schema accepts, or the session dies with a
  // parse error instead of a refusal. Built at the maximum, because a bound is only wrong there.
  const config = CustomLaunchConfigSchema.parse({
    provider: { kind: 'openrouter', credentialEnv: 'KEY' },
    models: [
      {
        selection: { provider: 'openrouter', model: 'fixture/model' },
        contextWindow: 8192,
        capabilities: ['tools'],
      },
    ],
    defaultModel: { provider: 'openrouter', model: 'fixture/model' },
    trustedRoots: ['/srv/fixture'],
    resources: [
      { id: 'instruction', kind: 'instruction', path: '/srv/fixture/i.md', sha256: 'a'.repeat(64) },
    ],
    tools: [
      'read_file',
      'write_file',
      'edit_file',
      'search_files',
      'glob',
      'list_directory',
      'run_command',
      'read_output',
      'read_resource',
    ],
    approvalTools: [],
    services: Array.from({ length: 8 }, (_, service) => ({
      id: `service-${service}`,
      command: '/usr/bin/true',
      // At the full name length too: a bound is only ever wrong at the maximum.
      tools: Array.from({ length: 32 }, (_, tool) =>
        `s${service}.${tool}.`.padEnd(128, 'o').slice(0, 128),
      ),
    })),
    approvalSecretEnv: 'SECRET',
    executables: { tool: '/usr/bin/true' },
    commandEnvironment: [],
  });
  const declared = declaredCustomToolNames(config);
  expect(declared).toHaveLength(MAX_DECLARED_CUSTOM_TOOLS);
  const profile = {
    runtime: 'custom',
    turnId: 'run',
    observedAt: new Date().toISOString(),
    recipeDigest: 'b'.repeat(64),
    model: { provider: 'openrouter', model: 'fixture/model' },
    tools: declared,
    resources: Array.from({ length: 32 }, (_, index) => ({
      id: `r${index}.`.padEnd(128, 'o').slice(0, 128),
      digest: 'c'.repeat(64),
      kind: 'skill' as const,
    })),
  };
  expect(RuntimeAppliedProfileSchema.parse(profile).tools).toHaveLength(declared.length);
  // And it must still be readable back: an oversize file returns null from the private read, which
  // is not a refusal but a silent "no retained profile".
  expect(
    Buffer.byteLength(
      JSON.stringify({ registration: crypto.randomUUID(), nativeId: 'n', profile }),
    ),
  ).toBeLessThan(64 * 1024);
});
