import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeOwner } from '../src/agent/claude/native/owner.ts';
import { RuntimeInputSchema, writeRuntimeInput } from '../src/runtime/input.ts';
import { nativeResponseFingerprint, writeNativeCommand } from '../src/runtime/response.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const FAKE_LIVE_SDK = `
export function query({ prompt, options }) {
  const queue = [];
  let wake = null;
  let closed = false;
  const push = (item) => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve({ value: item, done: false });
    } else {
      queue.push(item);
    }
  };
  const end = () => {
    closed = true;
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve({ value: undefined, done: true });
    }
  };
  (async () => {
    for await (const msg of prompt) {
      const text = typeof msg.message?.content === 'string'
        ? msg.message.content
        : msg.message?.content?.find((p) => p.type === 'text')?.text ?? '';
      if (text === 'ask-tool') {
        const decision = await options.canUseTool('Bash', { command: 'echo ok' }, {
          signal: new AbortController().signal,
          toolUseID: 'tu-1',
        });
        globalThis.__lastPermissionDecision = decision;
        push({
          type: 'stream_event',
          api_message_id: 'm1',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: decision.behavior } },
        });
      } else {
        push({
          type: 'stream_event',
          api_message_id: 'm1',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply:' + text } },
        });
      }
      push({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.01,
        modelUsage: {
          'claude-sonnet': {
            inputTokens: 12,
            outputTokens: 6,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 2,
          },
        },
      });
    }
  })().catch(() => {});
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (closed) return;
        const next = await new Promise((resolve) => { wake = resolve; });
        if (next.done) return;
        yield next.value;
      }
    },
    initializationResult: async () => ({ hooks_applied: true }),
    supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet', description: '' }],
    supportedCommands: async () => [],
    accountInfo: async () => ({ email: 'u@example.com' }),
    mcpServerStatus: async () => [],
    getContextUsage: async () => ({
      totalTokens: 100,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.05,
    }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: '2026-12-01T00:00:00.000Z' } },
    }),
    interrupt: async () => {},
    close: () => end(),
  };
}
`;

test('ClaudeNativeOwner runs turns, session-scoped approvals, usage and planLimits through stitchkit/agent-executor/claude-sdk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-claude-owner-e2e-'));
  roots.push(root);
  const sdkDir = join(root, 'sdk');
  mkdirSync(sdkDir);
  writeFileSync(join(sdkDir, 'sdk.mjs'), FAKE_LIVE_SDK);
  const generation = '55555555-5555-4555-8555-555555555555';
  const m = makeMachine({ stateDir: root, claudeNativeRuntime: true, claudeNativeSdk: sdkDir });
  const session = makeSession({
    name: 'agent-e2e',
    uuid: generation,
    dir: root,
    agent: 'claude',
    runtime: 'native',
    registrationGeneration: generation,
    nativeSession: { runtime: 'claude', id: generation, version: '0.3.332' },
  });

  const errors: unknown[] = [];
  const owner = new ClaudeNativeOwner(m, session, async (err) => {
    errors.push(err);
  });
  await owner.open();
  try {
    const initial = readManagedRuntimeStatus(m, session);
    expect(initial.status).toBe('live');
    if (initial.status !== 'live' || initial.snapshot === null)
      throw new Error('expected live snapshot');
    expect(initial.snapshot.planLimits?.answer).toBe('known');
    expect(initial.snapshot.planLimits?.windows[0]?.percent).toBe(25);

    // Run a turn that asks for Bash permission, answer acceptForSession, and verify SDK received session rule.
    await writeRuntimeInput(
      m,
      session,
      RuntimeInputSchema.parse({
        messageId: '66666666-6666-4666-8666-666666666666',
        nativeId: 'turn-perm-1',
        text: 'ask-tool',
        phase: 'queued',
      }),
    );
    await owner.tick(true);
    await waitFor(() => {
      const snap = readManagedRuntimeStatus(m, session);
      return (
        snap.status === 'live' &&
        snap.snapshot !== null &&
        snap.snapshot.pendingRequests.length === 1
      );
    }, 'pending approval');

    const waiting = readManagedRuntimeStatus(m, session);
    if (waiting.status !== 'live' || waiting.snapshot === null) throw new Error('expected live');
    const pending = waiting.snapshot.pendingRequests[0];
    if (!pending) throw new Error('expected pending request');
    expect(waiting.snapshot.state).toBe('waiting-approval');
    expect(pending.reason).toContain('Bash: echo ok');

    await writeNativeCommand(m, session.name, {
      operationId: '77777777-7777-4777-8777-777777777777',
      generation,
      requestId: pending.requestId,
      fingerprint: nativeResponseFingerprint({
        generation,
        requestId: pending.requestId,
        kind: 'approval',
        decision: 'acceptForSession',
        answers: null,
      }),
      kind: 'approval',
      decision: 'acceptForSession',
      answers: null,
    });
    await owner.tick(true);
    await waitFor(() => {
      const snap = readManagedRuntimeStatus(m, session);
      return (
        snap.status === 'live' &&
        snap.snapshot !== null &&
        snap.snapshot.turn?.status === 'completed'
      );
    }, 'turn completion');

    const completed = readManagedRuntimeStatus(m, session);
    if (completed.status !== 'live' || completed.snapshot === null)
      throw new Error('expected live');
    expect(completed.snapshot.state).toBe('idle');
    expect(completed.snapshot.spend?.totalCostUsd).toBe(0.01);
    expect(completed.snapshot.nativeItems.some((item) => item.text === 'allow')).toBe(true);
    expect(
      (globalThis as { __lastPermissionDecision?: unknown }).__lastPermissionDecision,
    ).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
    expect(errors).toEqual([]);
  } finally {
    await owner.close();
  }
});
