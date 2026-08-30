import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createAgentObservability,
  defineAgentProtocol,
  defineModelRegistry,
} from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { createHeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
import { createBunSqliteAgentRuntimeStore } from 'stitchkit/agent-runtime/sqlite/bun';
import { mountAgent } from 'stitchkit/tools';
import { z } from 'zod';

// Only published dependencies: no supervisor, metadata adapter, transport or provider network.
const root = await mkdtemp(join(tmpdir(), 'agent-approval-probe-'));
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
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
  doStream: [
    call('first'),
    call('second'),
    {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'DONE' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    },
  ],
});
const registry = defineModelRegistry({
  models: {
    fixture: {
      provider: 'fixture',
      modelId: 'fixture',
      contextWindow: 8192,
      capabilities: ['tools'],
    },
  },
  providers: { fixture: { create: () => model } },
});
const sqlite = createBunSqliteAgentRuntimeStore({ filename: join(root, 'conversation.sqlite') });
const diagnostics: string[] = [];
const observe = createAgentObservability({
  includeInternalCause: true,
  maxPending: 16,
  write: (event) => {
    if (event.type === 'run-terminal' && event.internalCause instanceof Error)
      diagnostics.push(`${event.internalCause.name}: ${event.internalCause.message}`);
  },
});
const harness = createHeadlessAgentHarness({
  protocol: defineAgentProtocol({
    context: z.object({}),
    inputMetadata: z.object({}),
    terminalAcceptance: 'require-output',
  }),
  store: sqlite.store,
  models: { resolve: () => registry.resolve('fixture') },
  resources: { load: () => ({ resources: [], diagnostics: [] }) },
  promptBudget: () => ({
    contextWindow: 8192,
    reservedOutput: 1024,
    toolSchemas: { value: 512, provenance: 'estimated' },
    attachments: { value: 0, provenance: 'measured' },
    providerOverhead: { provenance: 'unavailable' },
  }),
  tools: (context) =>
    mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }).filter(
        (tool) => tool.name === 'write_file',
      ),
      lifecycle: context.toolFenceLifecycle,
    }),
  loop: {
    maxSteps: 8,
    toolApprovalSecret: 'non-secret-fixed-approval-verification-key',
    toolApproval: { write_file: 'user-approval' },
  },
  observe,
});
let passed = false;
try {
  const conversationId = crypto.randomUUID();
  let ticket = harness.submit({
    conversationId,
    idempotencyKey: crypto.randomUUID(),
    context: {},
    metadata: {},
    parts: [{ type: 'text', text: 'write two files' }],
  });
  for (let n = 0; n < 2; n++) {
    const result = await ticket.result;
    const requests = await harness.pendingApprovals(conversationId);
    await observe.flush();
    console.log(
      JSON.stringify({ phase: n, terminal: result.reason, requests: requests.length, diagnostics }),
    );
    if (requests.length !== 1 || !requests[0])
      throw new Error('Expected one exact signed approval');
    ticket = await harness.respondToApproval({
      conversationId,
      approvalId: requests[0].approvalId,
      approved: true,
      context: {},
      metadata: {},
    });
  }
  const result = await ticket.result;
  await observe.flush();
  passed = result.reason === 'success' && (await Bun.file(join(root, 'second.txt')).exists());
  console.log(
    JSON.stringify({
      terminal: result.reason,
      firstEffect: await Bun.file(join(root, 'first.txt')).exists(),
      secondEffect: await Bun.file(join(root, 'second.txt')).exists(),
      modelCalls: model.doStreamCalls.length,
      diagnostics,
      passed,
    }),
  );
} finally {
  await harness.close();
  await observe.close();
  await sqlite.close();
  await rm(root, { recursive: true, force: true });
}
if (!passed) process.exitCode = 1;
