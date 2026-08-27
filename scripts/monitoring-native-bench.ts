import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { readMonitoringStatus, MONITORING_MAX_READERS } from "../src/monitoring-reader.ts";

// One resident process reading the existing daemon. No producer or supervised session is started.
const seconds = Number(Bun.argv[2] ?? 900);
if (!Number.isFinite(seconds) || seconds < 1) throw new Error("positive duration required");
let execAttempts = 0;
const forbidden = (): never => { execAttempts++; throw new Error("native reader attempted a subprocess"); };
spyOn(Bun, "spawn").mockImplementation(forbidden);
spyOn(Bun, "spawnSync").mockImplementation(forbidden);
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
  spyOn(childProcess, method).mockImplementation(forbidden);
}
const started = performance.now();
const cpuStart = process.cpuUsage();
const latencies: number[] = [];
const ages: number[] = [];
let reads = 0;
let changes = 0;
let cursor = "";
let rows = 0;
let producerVersion = "";
let maxHeap = 0;
let maxRss = 0;
let firstHeap = 0;
const sample = () => {
  Bun.gc(true);
  const memory = process.memoryUsage();
  maxRss = Math.max(maxRss, memory.rss);
  maxHeap = Math.max(maxHeap, memory.heapUsed);
  if (!firstHeap) firstHeap = memory.heapUsed;
  return memory.heapUsed;
};
async function read() {
  const at = performance.now();
  const result = await readMonitoringStatus();
  if (result.status !== "live" || !result.snapshot) throw new Error(`native read: ${result.status}/${result.reason}`);
  const snapshot = result.snapshot;
  // Fixed sample ring; the benchmark itself must not grow with duration.
  latencies[reads % 2048] = performance.now() - at;
  ages[reads % 2048] = Date.now() - Date.parse(snapshot.observedAt);
  const next = `${snapshot.generation}:${snapshot.sequence}`;
  if (cursor !== next) changes++;
  cursor = next;
  rows = snapshot.sessions.length;
  producerVersion = snapshot.version;
  reads++;
}
await read(); // Known-positive live probe before any timed loop.
for (let i = 0; i < 100; i++) await read();
await Promise.all(Array.from({ length: 100 }, () => read()));
sample();
let ticks = 0;
while (performance.now() - started < seconds * 1000) {
  await Promise.all([read(), read()]);
  if (++ticks % 30 === 0) {
    sample();
    console.log(JSON.stringify({ elapsedSeconds: Math.round((performance.now() - started) / 1000), reads, observedPublications: changes, rows }));
  }
  await Bun.sleep(1000);
}
const endHeap = sample();
const cpu = process.cpuUsage(cpuStart);
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
console.log(JSON.stringify({
  elapsedMs: performance.now() - started, reads, observedPublications: changes, rows, producerVersion,
  execAttempts, readerCpuMs: (cpu.user + cpu.system) / 1000,
  latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95),
  freshnessP95Ms: percentile(ages, 0.95), freshnessMaxMs: Math.max(...ages),
  firstHeapBytes: firstHeap, endHeapBytes: endHeap, maxHeapBytes: maxHeap, maxRssBytes: maxRss,
  retainedSnapshotCacheEntries: 0, maxConcurrentCallers: MONITORING_MAX_READERS,
}));
