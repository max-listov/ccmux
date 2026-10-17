import { expect, test } from 'bun:test';
import type { AgentProvider } from '../src/agent/index.ts';
import { settlePrompts } from '../src/commands/run.ts';
import { makeMachine, makeSession } from './helpers.ts';

// A watcher left running after its agent exited presses keys at the next launch.

test('the startup-menu watcher ends when its agent is gone, without reading the pane again', async () => {
  let asked = 0;
  const provider = {
    id: 'claude',
    settleMenu: () => {
      asked += 1;
      return { state: { armed: false, answered: false, pending: null }, action: { act: 'wait' } };
    },
  } as unknown as AgentProvider;
  const gone = new AbortController();
  gone.abort();
  const started = Date.now();
  await settlePrompts(makeMachine(), makeSession(), provider, gone.signal);
  expect(asked).toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
}, 20_000);
