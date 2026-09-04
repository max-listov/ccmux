import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { makeMachine } from './helpers.ts';

/**
 * A machine that is down must not cost every other machine its answer.
 *
 * The fan-out asks every peer at once and has a cell for "not reachable right now", so the caller
 * was made to wait out one machine's full connect attempt before seeing the ones that are up:
 * measured with a blackholed peer, eleven seconds to an answer whose other rows were ready in two,
 * and a consumer polling on a twelve-second bound lost the whole inventory on a coin toss.
 *
 * The dial is bounded and the execution is not, because those are different questions: a machine
 * that has not accepted a connection in a few seconds is not reachable now, while a machine that
 * accepted and is listing many sessions is answering. Cutting the whole deadline would draw a busy
 * machine as unreachable, which is the worse lie of the two.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('the fleet view bounds the dial, keeps the execution budget, and still names the failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-fleet-dial-'));
  roots.push(root);
  const recorded = join(root, 'argv.txt');
  // A stand-in for ssh that records how it was asked to dial and then reports a transport failure
  // the way ssh does. The alternative — a blackholed address — measures the network and costs the
  // very seconds this case is about. It has to be found by a CHILD process: `Bun.spawn` resolves
  // an executable against the PATH this process started with, so shimming `process.env.PATH` in
  // place resolves the real ssh and proves nothing.
  writeFileSync(join(root, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${recorded}\nexit 255\n`);
  chmodSync(join(root, 'ssh'), 0o755);
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const machine = makeMachine({
    stateDir,
    rcPrefix: 'host-a',
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
    tmuxSocket: `ccmux-fleet-dial-${process.pid}`,
    fleet: { 'host-b': 'user@host-b.invalid' },
  });
  const configPath = join(root, 'machine.json');
  writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.PATH = `${root}:${env.PATH ?? ''}`;
  env.CCMUX_CONFIG = configPath;
  env.CCMUX_STATE_DIR = stateDir;
  env.CCMUX_CACHE_DIR = join(root, 'cache');
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'fleet', '--json'], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const view = z
    .object({
      machines: z.array(
        z.object({
          machine: z.string(),
          ok: z.boolean(),
          error: z.string().nullable(),
          sessions: z.array(z.unknown()),
        }),
      ),
    })
    .parse(JSON.parse(out));
  const peer = view.machines.find((row) => row.machine === 'host-b');
  // The row is present and honest: a machine that could not be dialled is `ok: false` with the
  // reason, never a missing row and never a silent empty session list presented as fact.
  expect(peer?.ok).toBe(false);
  expect(peer?.error).toContain('unreachable');
  expect(peer?.sessions).toEqual([]);
  const argv = readFileSync(recorded, 'utf8').split('\n');
  expect(argv).toContain('ConnectTimeout=3');
  // Nothing else was shortened: the remote command keeps its full budget, which is what stops a
  // busy machine from being reported as a dead one.
  expect(argv).not.toContain('ConnectTimeout=10');
}, 30_000);
