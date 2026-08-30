import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildBundle } from '../scripts/bundle.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { VERSION } from '../src/util/version.ts';
import { makeMachine } from './helpers.ts';

test('bundled daemon self-update settles healing before clean SIGTERM and restored-bundle restart', async () => {
  const root = mkdtempSync('/tmp/ccmux-self-update-');
  const bundle = join(root, 'data/app/ccmux.js'),
    bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['launchctl', 'systemctl'])
    writeFileSync(
      join(bin, name),
      "#!/bin/sh\necho 'forbidden self service-manager restart' >&2\nexit 91\n",
      { mode: 0o755 },
    );
  const released = process.env.CCMUX_TEST_RELEASE_BUNDLE;
  if (released) {
    mkdirSync(join(root, 'data/app'), { recursive: true });
    copyFileSync(released, bundle);
  } else expect(await buildBundle(bundle)).toBe(true);
  const bytes = readFileSync(bundle),
    hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req): Response {
      requests++;
      if (new URL(req.url).pathname === '/bundle') return new Response(bytes);
      return Response.json({
        version: VERSION,
        notes: 'isolated self-update test',
        sha256: hash,
        url: new URL('/bundle', server.url).href,
      });
    },
  });
  const machine = makeMachine({
    rcPrefix: 'host-a',
    stateDir: join(root, 'state'),
    codexHome: join(root, 'no-provider'),
    claudeBin: '/usr/bin/false',
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
    tmuxSocket: `ccmux-self-update-${crypto.randomUUID()}`,
    autoUpdate: true,
    ensureInterval: 1,
    updateCheckInterval: 1,
    releaseUrl: new URL('/release', server.url).href,
    sessionEvents: false,
    chatEnabled: false,
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));
  const env = {
    ...process.env,
    CCMUX_CONFIG: config,
    CCMUX_RC_PREFIX: machine.rcPrefix,
    CCMUX_STATE_DIR: machine.stateDir,
    CCMUX_DATA_DIR: join(root, 'data'),
    CCMUX_CACHE_DIR: join(root, 'cache'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const start = () =>
    Bun.spawn([process.execPath, '--no-env-file', bundle, 'daemon'], {
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
  let daemon = start();
  let errors = new Response(daemon.stderr).text();
  const ready = async () => {
    const client = createControlClient({ socket: controlSocket(machine), timeoutMs: 100 });
    try {
      for (let n = 0; n < 100; n++) {
        try {
          return await client.list();
        } catch {}
        await Bun.sleep(20);
      }
      throw new Error('isolated daemon did not become ready');
    } finally {
      await client.close();
    }
  };
  try {
    const first = await ready();
    expect(first.version).toBe(VERSION);
    // The daemon is already loaded in memory. Only this test's disposable artifact is removed.
    unlinkSync(bundle);
    const timeout = setTimeout(() => daemon.kill('SIGKILL'), 10_000);
    const code = await daemon.exited;
    clearTimeout(timeout);
    const out = await errors;
    expect(code, out).toBe(143);
    expect(out).not.toContain('forbidden self service-manager restart');
    expect(out).toContain('auto-update applied — daemon restart requested');
    expect(out).toContain('"outcome":"clean"');
    expect(out).not.toContain('"force-failed"');
    expect(out).not.toContain('"daemon resource failed"');
    expect(existsSync(bundle)).toBe(true);
    expect(readFileSync(bundle).equals(bytes)).toBe(true);
    expect(requests).toBeGreaterThanOrEqual(2);
    daemon = start();
    errors = new Response(daemon.stderr).text();
    const second = await ready();
    expect(second.generation).not.toBe(first.generation);
    daemon.kill('SIGTERM');
    expect(await daemon.exited).toBe(143);
    expect(await errors).toContain('"outcome":"clean"');
  } finally {
    daemon.kill('SIGKILL');
    await daemon.exited;
    await errors;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
