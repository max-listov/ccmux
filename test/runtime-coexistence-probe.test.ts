import { expect, test } from 'bun:test';
import { settleRuntimePeers } from '../scripts/runtime-coexistence-e2e.ts';
import type { ManagedPeer } from '../src/types.ts';

const runtimes: ManagedPeer['agent'][] = ['opencode', 'codex'];
const targets: ManagedPeer[] = runtimes.map((agent, index) => ({
  kind: 'managed',
  source: 'ccmux',
  machine: 'host-a',
  agent,
  session: `agent-${index}`,
  threadId: crypto.randomUUID(),
}));

test('pickup acceptance services approvals arriving after the round trip', async () => {
  let waits = 0;
  let approved = false;
  const first = targets[0];
  if (!first) throw new Error('Missing first fixture');
  const generation = crypto.randomUUID();
  await settleRuntimePeers(
    {
      native: async ({ target }) => ({
        generation,
        pending:
          waits >= 2 && !approved && target === targets[0]
            ? [
                {
                  requestId: 'late-approval',
                  kind: 'approval',
                  approvalKind: null,
                  turnId: 'turn-a',
                  itemId: 'item-a',
                  reason: null,
                  scope: null,
                  decisions: ['accept'],
                  questions: [],
                  requestedAt: new Date().toISOString(),
                },
              ]
            : [],
      }),
      respond: async (input) => {
        expect(input.generation).toBe(generation);
        expect(input.target).toBe(first);
        expect(input.requestId).toBe('late-approval');
        expect(input.decision).toBe('accept');
        approved = true;
        return { operationId: input.operationId, requestId: input.requestId, outcome: 'submitted' };
      },
      wait: async ({ target }) => {
        waits++;
        return { target, state: null, outcome: approved ? 'completed' : 'timeout' };
      },
    },
    targets,
    Date.now() + 1_000,
  );
  expect(approved).toBe(true);
  expect(waits).toBe(4);
});

test('pickup acceptance does not turn failure into successful completion', async () => {
  await expect(
    settleRuntimePeers(
      {
        native: async () => ({ generation: crypto.randomUUID(), pending: [] }),
        respond: async () => {
          throw new Error('Unexpected approval');
        },
        wait: async ({ target }) => ({ target, state: null, outcome: 'failed' }),
      },
      targets,
      Date.now() + 1_000,
    ),
  ).rejects.toThrow('Cross-runtime pickup ended with failed');
});
