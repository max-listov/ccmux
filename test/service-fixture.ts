import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A real stdio MCP service, built by the framework's own `createStdioMcpServer` from a contract.
 *
 * Shared by the tests that mount one and by the tests that check what a session declaring one then
 * reports, because those two must be looking at the same service: a hand-written second fixture
 * would let the mount and the profile agree about a shape neither side actually publishes.
 */

const HOME = join(import.meta.dir, 'service-fixtures');
const roots: string[] = [];

/**
 * Remove what the fixtures wrote. Called from each test file's own `afterEach`, because an
 * `afterEach` registered here — in an imported module rather than in a test file — does not run for
 * every file that imports it, and four fixture directories were left in the tree before that was
 * noticed. They are also outside the typecheck: a run killed midway leaves one behind, and a
 * half-written server must not be able to fail the gate for everyone.
 */
export function clearServiceFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

const bun = Bun.which('bun');
if (!bun) throw new Error('bun is required for the service fixture');

/** Write a stdio MCP server exposing one contract, and return the executable and args to run it. */
export function stdioService(source: string): { command: string; args: string[] } {
  // Inside the tree on purpose: the child resolves `stitchkit` the way any real service would, from
  // the checkout's own modules. Written to the system temp directory it cannot resolve anything and
  // dies during the handshake, which reads as a protocol failure and is a missing dependency.
  mkdirSync(HOME, { recursive: true });
  const root = mkdtempSync(join(HOME, 'service-'));
  roots.push(root);
  const path = join(root, 'server.ts');
  writeFileSync(path, source);
  return { command: bun as string, args: [path] };
}

export const TASKS = `
import { defineContract } from 'stitchkit';
import { implement } from 'stitchkit/server';
import { createStdioMcpServer } from 'stitchkit/tools';
import { z } from 'zod';

const contract = defineContract({ prefix: '/tasks' }, {
  claim: {
    method: 'POST', path: '/claim', desc: 'Claim a task',
    input: z.object({ id: z.string(), force: z.boolean().optional(), tags: z.array(z.string()).optional() }),
    output: z.object({ ok: z.boolean(), saw: z.string(), key: z.string() }),
  },
  drop: {
    method: 'POST', path: '/drop', desc: 'Drop a task',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
});
const service = implement(contract, {
  claim: async ({ input }) => ({ ok: true, saw: input.id, key: process.env.TASKS_KEY ?? 'absent' }),
  drop: async () => ({ ok: true }),
});
await createStdioMcpServer({
  serverInfo: { name: 'tasks', version: '1.0.0' },
  services: [service],
  auth: undefined,
});
`;
