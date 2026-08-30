import { expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { invoke, output, refused } from '../scripts/custom-tool-observation';

function tool(execute: () => unknown): ToolSet {
  return { probe: { inputSchema: z.object({}), execute } };
}

test('tool qualification distinguishes successful error-shaped data from rejection', async () => {
  const result = await invoke(
    tool(() => ({ error: 'business-data' })),
    'probe',
    {},
  );
  expect(result.kind).toBe('returned');
  expect(output(result)).toEqual({ error: 'business-data' });
  expect(refused(result)).toBe(false);
});

test('tool qualification observes the mounted typed rejection channel', async () => {
  const result = await invoke(
    tool(() => {
      throw Object.assign(new Error('safe refusal'), {
        name: 'AgentToolError',
        output: { error: 'CONFLICT' },
        cause: new Error('private fixture'),
      });
    }),
    'probe',
    {},
  );
  expect(result).toEqual({ kind: 'rejected', mounted: true, code: 'CONFLICT' });
  expect(refused(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private fixture');
});

test('tool qualification never accepts an unexpected exception as a typed refusal', async () => {
  const result = await invoke(
    tool(() => {
      throw new Error('fixture error');
    }),
    'probe',
    {},
  );
  expect(result).toEqual({ kind: 'rejected', mounted: false, code: 'unexpected-rejection' });
  expect(refused(result)).toBe(false);
});
