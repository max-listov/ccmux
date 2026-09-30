import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';

const output = Bun.argv[2];
if (!output) throw new Error('output.json required');
const root = mkdtempSync(join(tmpdir(), 'ccmux-config-bench-'));
const original = process.env.CCMUX_CONFIG;
const originalPrefix = process.env.CCMUX_RC_PREFIX;
try {
  const path = join(root, 'machine.json');
  writeFileSync(
    path,
    JSON.stringify({
      claudeBin: '/usr/bin/false',
      tmuxBin: '/usr/bin/false',
      codexBin: '/usr/bin/false',
      opencodeBin: '/usr/bin/false',
      rcPrefix: 'bench',
      stateDir: root,
      projectsDir: root,
      bootLabel: 'bench',
    }),
  );
  process.env.CCMUX_CONFIG = path;
  process.env.CCMUX_RC_PREFIX = 'bench';
  for (let i = 0; i < 100; i++) loadMachineConfig();
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < 5000; i++) loadMachineConfig();
  await Bun.write(
    output,
    JSON.stringify(
      {
        calls: 5000,
        elapsedMs: performance.now() - start,
        cpu: process.cpuUsage(cpu),
        platform: process.platform,
        note: 'Pinned binaries; isolates file load/schema cost from optional binary detection.',
      },
      null,
      2,
    ),
  );
} finally {
  if (original === undefined) delete process.env.CCMUX_CONFIG;
  else process.env.CCMUX_CONFIG = original;
  if (originalPrefix === undefined) delete process.env.CCMUX_RC_PREFIX;
  else process.env.CCMUX_RC_PREFIX = originalPrefix;
  rmSync(root, { recursive: true, force: true });
}
