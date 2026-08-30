import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { openCustomEngine } from '../src/agent/custom/engine.ts';
import { customFixture, textStream, usage } from './custom-fixture.ts';

test('Custom multiple sequential approvals preserve all signed tool continuations', async () => {
  const { root, s, host } = await customFixture();
  const call = (id: string) => ({
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: id,
          toolName: 'write_file',
          input: JSON.stringify({ path: `${id}.txt`, content: id, overwrite: false }),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
        },
      ],
    }),
  });
  const model = new MockLanguageModelV4({
    doStream: [call('first'), call('second'), textStream()],
  });
  const diagnostics: unknown[] = [];
  const engine = await openCustomEngine({
    root: join(root, 'owner'),
    session: s,
    host,
    provider: { create: () => model },
    publish: () => undefined,
    onError: (error) => {
      diagnostics.push(error);
    },
  });
  const metadata = {
    registration: s.registrationGeneration,
    messageId: crypto.randomUUID(),
    recipeDigest: s.launchRecipe?.digest,
    model: host.config.defaultModel,
  };
  try {
    let ticket = engine.harness.submit({
      conversationId: engine.conversationId,
      context: engine.context,
      idempotencyKey: metadata.messageId,
      metadata,
      parts: [{ type: 'text', text: 'write two files' }],
    });
    for (let n = 0; n < 2; n++) {
      const result = await ticket.result;
      expect(result.reason).toBe('provider_stop');
      const requests = await engine.harness.pendingApprovals(engine.conversationId);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) throw new Error('Missing signed approval');
      ticket = await engine.harness.respondToApproval({
        conversationId: engine.conversationId,
        approvalId: request.approvalId,
        approved: true,
        context: engine.context,
        metadata: { ...metadata, parentRunId: request.runId },
      });
    }
    const result = await ticket.result;
    await engine.close();
    expect(diagnostics).toEqual([]);
    expect(result.reason).toBe('success');
    expect(await Bun.file(join(root, 'first.txt')).text()).toBe('first');
    expect(await Bun.file(join(root, 'second.txt')).text()).toBe('second');
    expect(model.doStreamCalls).toHaveLength(3);
  } finally {
    await engine.close();
  }
});
