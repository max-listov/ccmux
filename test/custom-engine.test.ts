import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { customArtifactStore } from '../src/agent/custom/artifacts.ts';
import { openCustomEngine } from '../src/agent/custom/engine.ts';
import { prepareCustomHost } from '../src/agent/custom/host.ts';
import { resolveControlLaunchRecipe } from '../src/config/launchRecipes.ts';

import { customFixture as fixture, textStream, usage } from './custom-fixture.ts';

test('Custom host recipe stays private and changing its definition fails closed', async () => {
  const { m, s, host } = await fixture();
  expect(host.config.defaultModel.model).toBe('fixture/model');
  expect(JSON.stringify(s.launchRecipe)).not.toContain('secret-like');
  expect(JSON.stringify(s.launchRecipe)).not.toContain('declared.env');
  expect(() => resolveControlLaunchRecipe(m, s.dir, s.launchRecipe, [])).toThrow('unavailable');
  const recipe = m.launchRecipes.coding;
  if (!recipe?.custom) throw new Error('fixture missing');
  recipe.custom.tools = [];
  expect(() => prepareCustomHost(m, s)).toThrow('unavailable');
});

test('Custom composition resolves the accepted model and continues a signed approval after reopen', async () => {
  const { root, s, host } = await fixture();
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'write-one',
              toolName: 'write_file',
              input: JSON.stringify({ path: 'effect.txt', content: 'once', overwrite: false }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ],
        }),
      },
      textStream(),
    ],
  });
  const openEngine = () =>
    openCustomEngine({
      root: join(root, 'owner'),
      session: s,
      host,
      provider: { create: () => model },
      publish: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
  let owner = await openEngine();
  const metadata = {
    registration: s.registrationGeneration,
    messageId: randomUUID(),
    recipeDigest: s.launchRecipe?.digest,
    model: host.config.defaultModel,
  };
  const conversationId = s.nativeSession?.id;
  if (!conversationId) throw new Error('fixture missing');
  try {
    const ticket = owner.harness.submit({
      conversationId,
      idempotencyKey: metadata.messageId,
      context: owner.context,
      metadata,
      parts: [{ type: 'text', text: 'write' }],
    });
    const admission = await ticket.admission;
    await ticket.result;
    const [pending] = await owner.harness.pendingApprovals(conversationId);
    expect(pending?.signature).toBeString();
    expect(await Bun.file(join(root, 'effect.txt')).exists()).toBe(false);
    await owner.close();
    owner = await openEngine();
    if (!pending) throw new Error('approval absent');
    const continuation = await owner.harness.respondToApproval({
      conversationId,
      approvalId: pending.approvalId,
      approved: true,
      context: owner.context,
      metadata: { ...metadata, parentRunId: admission.runId },
    });
    expect((await continuation.admission).runId).not.toBe(admission.runId);
    expect((await continuation.result).reason).toBe('success');
    expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe('once');
    expect(await owner.harness.recover({ resolveContext: () => owner.context })).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(2);
  } finally {
    await owner.close();
  }
});

test('Custom output references are bounded and scoped to one registration', async () => {
  const { root } = await fixture();
  const a = customArtifactStore(join(root, 'a'));
  const b = customArtifactStore(join(root, 'b'));
  const { reference } = await a.write({
    mediaType: 'text/plain',
    data: Buffer.from('fixture-output'),
  });
  expect(Buffer.from((await a.read({ reference, offset: 0, maxBytes: 7 })).data).toString()).toBe(
    'fixture',
  );
  await expect(b.read({ reference, offset: 0, maxBytes: 7 })).rejects.toThrow();
  await expect(a.read({ reference: '../escape', offset: 0, maxBytes: 7 })).rejects.toThrow();
  await expect(a.read({ reference, offset: 0, maxBytes: 65537 })).rejects.toThrow();
  await expect(
    a.write({ mediaType: 'text/plain', data: new Uint8Array(1024 * 1024 + 1) }),
  ).rejects.toThrow();
});
