import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountCustomService } from '../src/agent/custom/services.ts';

/**
 * A Custom session performing its owner's operations, mounted from a real child process.
 *
 * The server here is built by the framework's own `createStdioMcpServer` from a contract, spawned
 * as an actual process and spoken to over real stdio — not a fake handshake in this file. What is
 * under test is whether ccmux mounts what a service built the intended way offers, and a
 * hand-written fixture would only prove it mounts the shape I imagined.
 */

const roots: string[] = [];
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const entry of open.splice(0)) await entry.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const bun = Bun.which('bun');
if (!bun) throw new Error('bun is required for the service mount tests');

/** Write a stdio MCP server exposing one contract, and return the executable and args to run it. */
function server(source: string): { command: string; args: string[] } {
  // Inside the tree on purpose: the child resolves `stitchkit` the way any real service would, from
  // the checkout's own modules. Written to the system temp directory it cannot resolve anything and
  // dies during the handshake, which reads as a protocol failure and is a missing dependency.
  const root = mkdtempSync(join(import.meta.dir, 'service-fixture-'));
  roots.push(root);
  const path = join(root, 'server.ts');
  writeFileSync(path, source);
  return { command: bun as string, args: [path] };
}

const TASKS = `
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

test('a recipe mounts the operations it names and only those', async () => {
  const mounted = await mountCustomService(
    { id: 'tasks', ...server(TASKS), tools: ['claim__task'] },
    undefined,
  );
  open.push(mounted);
  expect(mounted.refused).toEqual([]);
  // `drop__task` is offered by the server and absent from the recipe, so the session never receives
  // it: widening what a session can reach stays a recipe change and a new digest.
  expect(mounted.tools.map((tool) => tool.name)).toEqual(['claim__task']);
  const input = mounted.tools[0]?.input;
  expect(input?.parse({ id: 'a', tags: ['x'] })).toEqual({ id: 'a', tags: ['x'] });
  // The optional/required split survives the handshake: `id` is required in the contract and stays
  // so, and the optional fields stay optional rather than becoming required or vanishing.
  expect(() => input?.parse({ force: true })).toThrow();
}, 30_000);

test('a mounted operation runs in the child, which receives only the declared credential', async () => {
  const mounted = await mountCustomService(
    { id: 'tasks', ...server(TASKS), credentialEnv: 'TASKS_KEY', tools: ['claim__task'] },
    'secret-value',
  );
  open.push(mounted);
  const result = (await mounted.tools[0]?.handler({ input: { id: 'a' } } as never)) as unknown;
  const body = JSON.stringify(result);
  expect(body).toContain('"saw":"a"');
  // The child sees the key the recipe declared for it — and nothing else from this process, which
  // is carrying the session's approval secret and the provider credential.
  expect(body).toContain('"key":"secret-value"');
}, 30_000);

test('a nullable field is mounted; a union of two real types is still refused', async () => {
  // Two branches where one is `null` is one shape that may be absent, not a union of meanings, and
  // it is the commonest form in a real contract tree. Refusing it cost a consumer half their
  // operations. A union of two REAL types stays refused: there the model would have to be told
  // which to send, and nothing here can tell it.
  const mounted = await mountCustomService(
    {
      id: 'tasks',
      ...server(TASKS.replace('force: z.boolean().optional()', 'force: z.boolean().nullable()')),
      tools: ['claim__task'],
    },
    undefined,
  );
  open.push(mounted);
  expect(mounted.refused).toEqual([]);
  const input = mounted.tools[0]?.input;
  expect(input?.parse({ id: 'a', force: null })).toEqual({ id: 'a', force: null });
  expect(input?.parse({ id: 'a', force: true })).toEqual({ id: 'a', force: true });
  expect(() => input?.parse({ id: 'a', force: 'yes' })).toThrow();
}, 30_000);

test('an operation whose shape cannot be read is refused by name, not guessed at', async () => {
  // A union input is a shape this converter does not mount. The whole service must not be lost to
  // one such operation, and it must not be mounted with an invented schema either: a guessed input
  // is a tool the model calls wrongly forever with nothing pointing back at the cause.
  const mounted = await mountCustomService(
    {
      id: 'tasks',
      ...server(
        TASKS.replace('id: z.string(), force', 'id: z.union([z.string(), z.number()]), force'),
      ),
      tools: ['claim__task'],
    },
    undefined,
  );
  open.push(mounted);
  expect(mounted.tools).toEqual([]);
  expect(mounted.refused.map((row) => row.name)).toEqual(['claim__task']);
}, 30_000);
