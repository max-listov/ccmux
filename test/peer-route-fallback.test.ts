import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { makeMachine } from './helpers.ts';

/**
 * A machine on the remote route falls back to ssh only when that route never dispatched the call.
 *
 * With every peer on ssh, each fan-out was one ssh per machine, and once the shared master's session
 * slots were taken each of them became a full login on the server. The remote route removes that; ssh
 * stays for when the route is down. The one case that must NOT fall back is a call the route may
 * already have delivered: a second path would run it twice.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FleetSchema = z.object({
  machines: z.array(
    z.object({
      machine: z.string(),
      alias: z.string().nullable(),
      ok: z.boolean(),
      error: z.string().nullable(),
      fallback: z.string().nullable(),
    }),
  ),
});

async function fleetThrough(socket: string) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-route-fallback-'));
  roots.push(root);
  const recorded = join(root, 'ssh-called');
  // A stand-in for ssh found by the child's PATH: it records that it was asked, then fails the way
  // ssh does, so the row is a transport failure and nothing depends on a real network.
  writeFileSync(join(root, 'ssh'), `#!/bin/sh\ntouch ${recorded}\nexit 255\n`);
  chmodSync(join(root, 'ssh'), 0o755);
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const machine = makeMachine({
    stateDir,
    rcPrefix: 'host-a',
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
    tmuxSocket: `ccmux-route-fallback-${process.pid}`,
    fleet: { 'host-b': 'user@host-b.invalid' },
    remoteTransport: { socket, peers: ['host-b'] },
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
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const peer = FleetSchema.parse(JSON.parse(out)).machines.find((row) => row.machine === 'host-b');
  return { peer, sshCalled: existsSync(recorded), err };
}

test('a peer whose remote route is down is asked over ssh, and the row says why', async () => {
  const { peer, sshCalled, err } = await fleetThrough('/nonexistent/remote-adapter.sock');
  expect(sshCalled).toBe(true);
  expect(peer?.fallback).toBe('local remote adapter is unavailable');
  // The row names the path it actually took, not the one configured.
  expect(peer?.alias).toBe('user@host-b.invalid');
  expect(err).toContain('remote route fell back to ssh');
}, 30_000);

test('a call the remote route may have delivered is never repeated over ssh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-route-adapter-'));
  roots.push(root);
  const socket = join(root, 'adapter.sock');
  // An adapter that takes the request and hangs up: the call left this machine, so whether it ran
  // on the far side is unknown.
  const server = Bun.listen({
    unix: socket,
    socket: {
      data(connection) {
        connection.end();
      },
    },
  });
  try {
    const { peer, sshCalled } = await fleetThrough(socket);
    expect(sshCalled).toBe(false);
    expect(peer?.ok).toBe(false);
    expect(peer?.fallback).toBeNull();
    expect(peer?.alias).toBe('remote');
  } finally {
    server.stop(true);
  }
}, 30_000);
