import { readFileSync } from 'node:fs';
import type { ManagedScheduleClock } from 'stitchkit/application';
import { loadMachineConfig } from '../src/config/machine.ts';
import { createDaemonApplication } from '../src/daemon/application.ts';
import '../src/monitoring/tmux.ts';
import '../src/session/pendingStore.ts';
import '../src/session/readyStore.ts';
import '../src/usage/store.ts';
import { producerMetrics } from '../src/util/producerMetrics.ts';

/** One producer's counters, read through the same channel the daemon serves. */
const metric = (name: string) => producerMetrics.snapshot()[name] ?? {};

const files = () => ({
  config: metric('machineFile'),
  ready: metric('readyFile'),
  pending: metric('pendingFile'),
});
const io = () =>
  process.platform === 'linux' ? readFileSync(`/proc/${process.pid}/io`, 'utf8') : null;

const only = Bun.argv[3] === '--attribution' ? undefined : Bun.argv[3];
let steadyWindow = false;
const clockFor = (id: string): ManagedScheduleClock => ({
  now: () => performance.now(),
  wallNow: () => new Date(),
  schedule(callback, delay) {
    const timer = setTimeout(() => {
      if (!steadyWindow || only === id) callback();
    }, delay);
    return { cancel: () => clearTimeout(timer) };
  },
});
const owned = createDaemonApplication(loadMachineConfig(), only ? clockFor : undefined);
const coldCpu = process.cpuUsage();
const coldAt = performance.now();
await owned.application.start();
if (Bun.argv.includes('--attribution')) owned.performance.start();
await Bun.sleep(15000);
const cold = {
  elapsedMs: performance.now() - coldAt,
  cpu: process.cpuUsage(coldCpu),
  memory: process.memoryUsage(),
  files: files(),
  usageStores: metric('usageStore'),
  external: {
    status: owned.external.read().status,
    threads: owned.external.read().sessions.length,
  },
};
steadyWindow = true;
// Let excluded callbacks drain before the attribution interval; the full run has no such pause.
if (only) await Bun.sleep(3500);
const ioBefore = io();
const execs = metric('observation').execCount ?? 0;
const childCpu = metric('observation').childCpuUs ?? 0;
const cpu = process.cpuUsage();
const attributionBefore = owned.performance.snapshot();
const at = performance.now();
const until = performance.now() + Number(Bun.argv[2] ?? 600) * 1000;
while (performance.now() < until) await Bun.sleep(Math.max(1, until - performance.now()));
const steady = {
  elapsedMs: performance.now() - at,
  cpu: process.cpuUsage(cpu),
  attributionBefore,
  attributionAfter: owned.performance.snapshot(),
  memory: process.memoryUsage(),
  observationExecs: (metric('observation').execCount ?? 0) - execs,
  observationChildCpuUs: (metric('observation').childCpuUs ?? 0) - childCpu,
  files: files(),
  ioBefore,
  ioAfter: io(),
  usageStores: metric('usageStore'),
};
const schedules = Object.fromEntries(
  Object.entries(owned.schedules).map(([id, schedule]) => [id, schedule.status]),
);
await owned.application.shutdown();
console.log(
  JSON.stringify({
    cold,
    steady,
    schedules,
    mode: only ? `isolated schedule: ${only}` : 'full application',
  }),
);
