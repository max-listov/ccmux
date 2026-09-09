import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentUsageSchema } from 'stitchkit/agent-runtime';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { subagentsDir } from '../src/agent/claude/subagent.ts';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { OpenCodeMessageSchema } from '../src/agent/opencode/protocol.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { recordClaudeSdkUsage } from '../src/usage/claudeSdk.ts';
import { customUsage, recordUsage } from '../src/usage/live.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { readSessionUsage } from '../src/usage/service.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync('/tmp/ccmux-usage-live-');
  roots.push(root);
  return {
    root,
    m: makeMachine({ stateDir: root, rcPrefix: 'host-a', projectsDir: join(root, 'projects') }),
  };
}

test('OpenCode tool-call usage survives nonterminal filtering, correction and owner restart', async () => {
  const { m } = fixture();
  const s = makeSession({
    name: 'agent-a',
    agent: 'opencode',
    runtime: 'native',
    nativeSession: { runtime: 'opencode', id: 'ses_fixture', version: '1.18.27' },
  });
  await writeSessionsUnlocked(m, [s]);
  const message = OpenCodeMessageSchema.parse({
    id: 'step',
    sessionID: 'ses_fixture',
    parentID: 'turn',
    role: 'assistant',
    time: {
      created: Date.parse('2026-01-01T00:00:00Z'),
      completed: Date.parse('2026-01-01T00:00:01Z'),
    },
    finish: 'tool-calls',
    modelID: 'model-a',
    providerID: 'provider-a',
    tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } },
  });
  const projection = new OpenCodeProjection(m, s, 123);
  projection.start('turn');
  projection.message(message, false);
  projection.message(message);
  const resumed = new OpenCodeProjection(m, s, 123);
  resumed.message(message);
  const read = await readSessionUsage(m, 'host-a:agent-a', UsageQuerySchema.parse({}));
  expect(projection.snapshot().turn?.status).toBe('inProgress');
  expect(read.self.values).toEqual({
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 3,
    cacheReadTokens: 7,
    cacheCreationTokens: 2,
    totalTokens: null,
  });
  expect(read.history).toBe('observed-live');
  expect(read.source).toBe('unsupported');
  expect(read.self.fieldCoverage.cacheCreationTokens).toBe('partial');
  expect(read.buckets[0]?.model).toBe('model-a');
});

test('Custom cache writes and cost provenance reach the typed summary without currency mixing', async () => {
  const { m } = fixture();
  const s = makeSession({
    name: 'agent-a',
    agent: 'custom',
    runtime: 'native',
    nativeSession: { runtime: 'custom', id: 'conversation', version: '0.81.0' },
  });
  await writeSessionsUnlocked(m, [s]);
  const usage = AgentUsageSchema.parse({
    inputTokens: { value: 10, provenance: 'provider-reported' },
    outputTokens: { value: 0, provenance: 'computed' },
    cacheWriteTokens: { value: 9, provenance: 'provider-reported' },
    cost: { value: 0.25, currency: 'USD', provenance: 'estimated' },
  });
  const fact = customUsage(
    usage,
    'run',
    'conversation',
    '2026-01-01T00:00:00Z',
    'model-a',
    'provider-a',
  );
  recordUsage(m, s.uuid, fact);
  recordUsage(m, s.uuid, fact);
  recordUsage(m, s.uuid, {
    ...fact,
    id: 'run-two',
    cost: { value: 2, currency: 'EUR', provenance: 'provider-reported' },
  });
  const read = await readSessionUsage(m, 'host-a:agent-a', UsageQuerySchema.parse({}));
  expect(read.self.values.cacheCreationTokens).toBe(18);
  expect(read.self.values.outputTokens).toBe(0);
  expect(read.self.values.cacheReadTokens).toBeNull();
  expect(read.buckets[0]?.provenance?.cacheCreationTokens).toBe('provider-reported');
  expect(read.self.costs).toEqual([
    { currency: 'USD', reported: 0.25, observations: 1, provenance: 'estimated' },
    { currency: 'EUR', reported: 2, observations: 1, provenance: 'provider-reported' },
  ]);
});

test('Claude self, child and SDK query pipeline are separate accounting scopes', async () => {
  const { m, root } = fixture();
  const s = makeSession({ name: 'agent-a', agent: 'claude', dir: root });
  await writeSessionsUnlocked(m, [s]);
  const directory = join(m.projectsDir, encodeDir(root));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${s.uuid}.jsonl`);
  const line = (id: string, input: number) =>
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id,
        role: 'assistant',
        model: 'model-a',
        content: [],
        usage: { input_tokens: input, output_tokens: 5 },
      },
    })}\n`;
  writeFileSync(path, line('parent', 10));
  mkdirSync(subagentsDir(path), { recursive: true });
  writeFileSync(join(subagentsDir(path), 'agent-abc123.jsonl'), line('child', 20));
  const result: SDKResultMessage = {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: false,
    num_turns: 1,
    result: 'not-accounting-data',
    stop_reason: null,
    total_cost_usd: 0.5,
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: s.uuid,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: 'not_available',
      speed: 'standard',
      iterations: [],
      output_tokens_details: { thinking_tokens: 0 },
      fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    },
    modelUsage: {
      'model-a': {
        inputTokens: 40,
        outputTokens: 15,
        thinkingTokens: 4,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 2,
        costUSD: 0.5,
        webSearchRequests: 1,
        contextWindow: 200000,
        maxOutputTokens: 64000,
        canonicalModel: 'canonical-a',
        provider: 'provider-a',
        costBasis: 'managed',
      },
    },
  };
  recordClaudeSdkUsage(m, s.uuid, 'query-one', result);
  recordClaudeSdkUsage(m, s.uuid, 'query-one', result);
  const read = await readSessionUsage(m, 'host-a:agent-a', UsageQuerySchema.parse({}), true);
  const child = await readSessionUsage(
    m,
    'host-a:agent-a#abc123',
    UsageQuerySchema.parse({}),
    true,
  );
  expect(read.self.values.inputTokens).toBe(10);
  expect(child.self.values.inputTokens).toBe(20);
  expect(read.delegated.addresses).toEqual(['host-a:agent-a#abc123']);
  expect(read.reportedPipeline?.usage.values.inputTokens).toBe(40);
  expect(read.reportedPipeline?.usage.values.reasoningTokens).toBe(4);
  expect(read.reportedPipeline?.usage.values.outputTokens).toBe(15);
  expect(read.reportedPipeline?.buckets[0]?.outputIncludesReasoning).toBe(true);
  expect(read.reportedPipeline?.buckets[0]?.details).toMatchObject({
    canonicalModel: 'canonical-a',
    costBasis: 'managed',
    webSearchRequests: 1,
  });
  expect(read.reportedPipeline?.usage.costs[0]).toMatchObject({
    reported: 0.5,
    provenance: 'estimated',
  });
  expect(read.additivity).toBe('session-only');
});
