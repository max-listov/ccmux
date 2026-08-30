import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { openCustomEngine } from '../src/agent/custom/engine.ts';
import { prepareCustomHost } from '../src/agent/custom/host.ts';
import { CustomProfile } from '../src/agent/custom/profile.ts';
import { customFixture, textStream } from './custom-fixture.ts';

test('Custom declared resources, lazy skill and applied profile retain pinned private provenance', async () => {
  const instruction = 'Always preserve the fixture word RESOURCE_PROOF.';
  const skill =
    '---\nname: inspect-fixture\ndescription: Inspect an isolated verification fixture.\n---\nKeep all effects inside this workspace.';
  const { root, m, s, host } = await customFixture(async (root, config) => {
    config.trustedRoots = [root];
    config.tools.push('read_resource');
    for (const [id, kind, body] of [
      ['instruction', 'instruction', instruction],
      ['skill', 'skill', skill],
    ] as const) {
      const path = join(root, `${id}.md`);
      await writeFile(path, body, { mode: 0o600 });
      config.resources.push({
        id,
        kind,
        path,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  });
  const model = new MockLanguageModelV4({ doStream: textStream() });
  const profile = new CustomProfile(join(root, 'engine'), s, host);
  const applied: Awaited<ReturnType<CustomProfile['applied']>>[] = [];
  const engine = await openCustomEngine({
    root: join(root, 'engine'),
    session: s,
    host,
    provider: { create: () => model },
    publish: () => undefined,
    onError: (error) => {
      throw error;
    },
    onProfile: async (event) => {
      applied.push(await profile.applied(event));
    },
  });
  try {
    const ticket = engine.harness.submit({
      conversationId: engine.conversationId,
      context: engine.context,
      idempotencyKey: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'inspect fixture' }],
      metadata: {
        registration: s.registrationGeneration,
        messageId: crypto.randomUUID(),
        recipeDigest: s.launchRecipe?.digest,
        model: host.config.defaultModel,
      },
    });
    await ticket.result;
    expect(applied).toHaveLength(1);
    expect(applied[0]?.resources.map((resource) => resource.id).sort()).toEqual([
      'instruction',
      'skill',
    ]);
    expect(applied[0]?.tools).toContain('read_resource');
    expect(JSON.stringify(applied)).not.toContain(root);
    expect(JSON.stringify(applied)).not.toContain(instruction);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('RESOURCE_PROOF');
    expect(await profile.read(engine)).toEqual(applied[0] ?? null);
    await writeFile(join(root, 'instruction.md'), 'changed');
    expect(() => prepareCustomHost(m, s)).toThrow();
  } finally {
    await engine.close();
  }
});
