#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { defineAgentProtocol } from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { createHeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
import { createBunSqliteAgentRuntimeStore } from 'stitchkit/agent-runtime/sqlite/bun';
import { z } from 'zod';

// A deterministic provider is deliberate: this qualifies the actual published engine/store and
// real filesystem effects under lost acknowledgements and restart, not model availability.
const toolsPath = process.argv[2];
if (!toolsPath) throw new Error('Pass the peer-complete published Stitchkit tools entrypoint');
const { mountAgent }: typeof import('stitchkit/tools') = await import(
  pathToFileURL(toolsPath).href
);
const root = await mkdtemp(join(tmpdir(), 'ccmux-harness-qualification-'));
const filename = join(root, 'conversation.sqlite');
const conversationId = randomUUID();
const secret = randomUUID();
const observations: { probe: string; passed: boolean; evidence: unknown }[] = [];
const record = (probe: string, passed: boolean, evidence: unknown) =>
  observations.push({ probe, passed, evidence });
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const textStream = (text: string): Awaited<ReturnType<MockLanguageModelV4['doStream']>> => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: text },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ],
  }),
});
const writeStream = (path: string): Awaited<ReturnType<MockLanguageModelV4['doStream']>> => ({
  stream: simulateReadableStream({
    chunks: [
      {
        type: 'tool-call',
        toolCallId: randomUUID(),
        toolName: 'write_file',
        input: JSON.stringify({ path, content: 'approved fixture', overwrite: false }),
      },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ],
  }),
});
const protocol = defineAgentProtocol({
  context: z.object({}).strict(),
  inputMetadata: z.object({ fixture: z.literal(true) }).strict(),
  terminalAcceptance: 'require-output',
});
function open(model: MockLanguageModelV4) {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename });
  const harness = createHeadlessAgentHarness({
    protocol,
    store: sqlite.store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'fixture',
          modelId: 'scripted',
          contextWindow: 8192,
          capabilities: ['tools'],
        },
        model,
      }),
    },
    resources: { load: () => ({ resources: [], diagnostics: [] }) },
    tools: (context) =>
      mountAgent([], {
        runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
        lifecycle: context.toolFenceLifecycle,
      }),
    promptBudget: ({ contextWindow }) => ({
      contextWindow,
      reservedOutput: 1024,
      toolSchemas: { value: 1024, provenance: 'estimated' },
      attachments: { value: 0, provenance: 'measured' },
      providerOverhead: { provenance: 'unavailable' },
    }),
    loop: {
      toolApproval: { write_file: 'user-approval' },
      toolApprovalSecret: secret,
      idleTimeoutMs: 1000,
    },
  });
  return {
    harness,
    sqlite,
    async close() {
      await harness.close();
      await sqlite.close();
    },
  };
}
const input = (idempotencyKey: string) => ({
  conversationId,
  idempotencyKey,
  context: {},
  metadata: { fixture: true },
  parts: [{ type: 'text' as const, text: 'Apply the fixture change.' }],
});
let owner: ReturnType<typeof open> | undefined;
try {
  await writeFile(join(root, 'readable.txt'), 'positive control');
  const firstModel = new MockLanguageModelV4({ doStream: [writeStream('allowed.txt')] });
  owner = open(firstModel);
  const initial = owner.harness.submit(input('first'));
  const admission = await initial.admission;
  const requested = await initial.result;
  const [pending] = await owner.harness.pendingApprovals(conversationId);
  record(
    'approval-stops-before-effect',
    pending !== undefined && !(await Bun.file(join(root, 'allowed.txt')).exists()),
    {
      reason: requested.reason,
      pending: pending !== undefined,
      signed: !!pending?.signature,
    },
  );
  if (!pending) throw new Error('Positive approval control failed');
  const retry = owner.harness.submit(input('first'));
  const retryAdmission = await retry.admission;
  await retry.result;
  record(
    'same-input-one-run',
    retryAdmission.runId === admission.runId && firstModel.doStreamCalls.length === 1,
    {
      sameRun: retryAdmission.runId === admission.runId,
      modelCalls: firstModel.doStreamCalls.length,
    },
  );
  await owner.close();
  owner = undefined;

  const secondModel = new MockLanguageModelV4({
    doStream: [textStream('done'), writeStream('denied.txt'), textStream('denied')],
  });
  owner = open(secondModel);
  const recovered = await owner.harness.pendingApprovals(conversationId);
  record(
    'restart-preserves-signed-request',
    recovered.length === 1 &&
      recovered[0]?.approvalId === pending.approvalId &&
      recovered[0]?.signature === pending.signature,
    {
      sameApproval: recovered[0]?.approvalId === pending.approvalId,
      sameRun: recovered[0]?.runId === admission.runId,
    },
  );
  const allow = await owner.harness.respondToApproval({
    conversationId,
    approvalId: pending.approvalId,
    approved: true,
    context: {},
    metadata: { fixture: true },
  });
  const successor = await allow.admission;
  const allowed = await allow.result;
  const actual = await readFile(join(root, 'allowed.txt'), 'utf8').catch(() => null);
  record(
    'approval-successor-executes-once',
    allowed.reason === 'success' &&
      actual === 'approved fixture' &&
      successor.runId !== admission.runId &&
      successor.input.role === 'tool',
    {
      reason: allowed.reason,
      separateRun: successor.runId !== admission.runId,
      inputRole: successor.input.role,
      correctContent: actual === 'approved fixture',
    },
  );
  await owner.harness.submit(input('denied')).result;
  const [denied] = await owner.harness.pendingApprovals(conversationId);
  if (!denied) throw new Error('Positive denial request control failed');
  const deny = await owner.harness.respondToApproval({
    conversationId,
    approvalId: denied.approvalId,
    approved: false,
    context: {},
    metadata: { fixture: true },
  });
  const deniedResult = await deny.result;
  record(
    'denial-has-no-effect',
    deniedResult.reason === 'success' && !(await Bun.file(join(root, 'denied.txt')).exists()),
    { reason: deniedResult.reason },
  );
  const page = await owner.sqlite.conversations.messages({
    conversationId,
    limit: 2,
    direction: 'before',
  });
  record('bounded-history-page', page.items.length === 2 && page.nextCursor !== undefined, {
    messages: page.items.length,
    hasMore: page.nextCursor !== undefined,
  });
  await owner.close();
  owner = undefined;
  const lastModel = new MockLanguageModelV4({ doStream: [textStream('unexpected')] });
  owner = open(lastModel);
  const recovery = await owner.harness.recover({ resolveContext: () => ({}) });
  record(
    'terminal-reopen-no-replay',
    recovery.length === 0 &&
      lastModel.doStreamCalls.length === 0 &&
      (await owner.harness.pendingApprovals(conversationId)).length === 0,
    { recoverable: recovery.length, modelCalls: lastModel.doStreamCalls.length },
  );
  console.log(JSON.stringify({ scriptedProvider: true, observations }, null, 2));
  if (observations.some(({ passed }) => !passed)) process.exitCode = 1;
} finally {
  await owner?.close();
  await rm(root, { recursive: true, force: true });
}
