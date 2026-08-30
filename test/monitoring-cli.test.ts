import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle } from '../scripts/bundle.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { MonitoringReadSchema } from '../src/monitoring/schema.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('bundled CLI concurrent reads, large output and cancellation never touch a pane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-status-cli-'));
  const marker = join(root, 'called');
  const bin = join(root, 'tmux');
  writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: root,
    projectsDir: join(root, 'transcripts'),
    tmuxBin: bin,
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(m));
  const bundle = join(root, 'ccmux.js');
  const env = { ...process.env, CCMUX_CONFIG: config };
  const p = new MonitoringPublisher();
  try {
    expect(await buildBundle(bundle)).toBe(true);
    const missing = Bun.spawn([process.execPath, bundle, 'status', '--json'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const missingText = await new Response(missing.stdout).text();
    expect(await missing.exited).toBe(3);
    expect(MonitoringReadSchema.parse(JSON.parse(missingText)).reason).toBe('missing');
    p.begin(m);
    for (let i = 0; i < 200; i++)
      p.sample(
        m,
        makeSession({ name: `agent-${i}`, dir: `/${'x'.repeat(2000)}` }),
        undefined,
        null,
        UNSEEN,
      );
    const snapshot = await p.publish(m);
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const child = Bun.spawn([process.execPath, bundle, 'status', '--json'], {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const text = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        expect(text.length).toBeGreaterThan(65536);
        return MonitoringReadSchema.parse(JSON.parse(text)).snapshot;
      }),
    );
    for (const result of results) expect(result).toEqual(snapshot);
    // A reader whose pipe is not drained is cancellable without touching the producer.
    const blocked = Bun.spawn([process.execPath, bundle, 'status', '--json'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await Bun.sleep(100);
    const start = performance.now();
    blocked.kill('SIGTERM');
    await blocked.exited;
    expect(performance.now() - start).toBeLessThan(1000);
    expect(existsSync(marker)).toBe(false);
    p.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
