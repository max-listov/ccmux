import { readFileSync } from 'node:fs';
import type { ManagedScheduleClock } from 'stitchkit/application';
import { loadMachineConfig, machineFileMetrics } from '../src/config/machine.ts';
import { createDaemonApplication } from '../src/daemon/application.ts';
import { observationChildCpuUs, observationExecCount } from '../src/monitoring/tmux.ts';
import { pendingFileMetrics } from '../src/session/pendingStore.ts';
import { readyFileMetrics } from '../src/session/readyStore.ts';
import { usageStoreMetrics } from '../src/usage/store.ts';

const files = () => ({
  config: machineFileMetrics(),
  ready: readyFileMetrics(),
  pending: pendingFileMetrics(),
});
const io = () =>
  process.platform === 'linux' ? readFileSync(`/proc/${process.pid}/io`, 'utf8') : null;

const only = Bun.argv[3];
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
await Bun.sleep(15000);
const cold = {
  elapsedMs: performance.now() - coldAt,
  cpu: process.cpuUsage(coldCpu),
  memory: process.memoryUsage(),
  files: files(),
  usageStores: usageStoreMetrics(),
  external: {
    status: owned.external.read().status,
    threads: owned.external.read().sessions.length,
  },
};
steadyWindow = true;
// Let excluded callbacks drain before the attribution interval; the full run has no such pause.
if (only) await Bun.sleep(3500);
const ioBefore = io();
const execs = observationExecCount();
const childCpu = observationChildCpuUs();
const cpu = process.cpuUsage();
const at = performance.now();
const until = performance.now() + Number(Bun.argv[2] ?? 600) * 1000;
while (performance.now() < until) await Bun.sleep(Math.max(1, until - performance.now()));
const steady = {
  elapsedMs: performance.now() - at,
  cpu: process.cpuUsage(cpu),
  memory: process.memoryUsage(),
  observationExecs: observationExecCount() - execs,
  observationChildCpuUs: observationChildCpuUs() - childCpu,
  files: files(),
  ioBefore,
  ioAfter: io(),
  usageStores: usageStoreMetrics(),
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
