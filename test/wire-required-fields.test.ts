import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWire } from '../src/fleet/wire.ts';
import { makeMachine } from './helpers.ts';

test('no required door field can be defaulted into a successful command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-door-fields-'));
  const socket = join(root, 'agent.sock');
  const valid = {
    v: 2,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'host-b',
    code: 0,
    stdout: '',
    stderr: '',
    failure: 'none',
    refusal: 'none',
    retryAfterMs: null,
    detail: '',
    truncated: false,
  };
  let reply: unknown = valid;
  const server = Bun.serve({ unix: socket, fetch: () => Response.json(reply) });
  try {
    const machine = makeMachine({ wire: { socket, peers: ['host-b'] } });
    const invoke = () => runWire(machine, 'host-b', ['ccmux', 'list']);
    expect((await invoke()).transportFailed).toBe(false);
    for (const field of Object.keys(valid)) {
      reply = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
      expect((await invoke()).transportFailed, `missing ${field}`).toBe(true);
    }
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
