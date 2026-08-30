import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMonitoringReader } from '../scripts/build-monitoring-reader.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { VERSION } from '../src/util/version.ts';
import { makeMachine } from './helpers.ts';

test('release native ESM asset loads offline and reads in-process without runtime dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-native-asset-'));
  try {
    const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
    const config = join(root, 'machine.json');
    // Native discovery must not require provider binaries or other private launch settings.
    writeFileSync(config, JSON.stringify({ stateDir: root, rcPrefix: 'host-a' }));
    const publisher = new MonitoringPublisher();
    publisher.begin(machine);
    await publisher.publish(machine);
    await buildMonitoringReader(root);
    const asset = join(root, 'monitoring-reader.js');
    const hash = new Bun.CryptoHasher('sha256').update(readFileSync(asset)).digest('hex');
    expect(readFileSync(join(root, 'monitoring-reader.sha256'), 'utf8')).toBe(
      `${hash}  monitoring-reader.js\n`,
    );
    const script = `
      import { spyOn } from "bun:test";
      spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("forbidden spawn"); });
      spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("forbidden spawnSync"); });
      const api = await import(${JSON.stringify(asset)});
      if (api.MONITORING_READER_VERSION !== ${JSON.stringify(VERSION)}) throw new Error("wrong version");
      for (const result of await Promise.all(Array.from({length: 100}, () => api.readMonitoringStatus({timeoutMs:1000})))) {
        if (result.status !== "live" || result.snapshot.rcPrefix !== "host-a") throw new Error(JSON.stringify(result));
      }
      console.log("native asset OK");
    `;
    const proc = Bun.spawn([process.execPath, '--no-env-file', '--no-install', '--eval', script], {
      cwd: root,
      env: { ...process.env, CCMUX_CONFIG: config, CCMUX_RC_PREFIX: 'host-a' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exit, err, out }).toEqual({ exit: 0, err: '', out: 'native asset OK\n' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
