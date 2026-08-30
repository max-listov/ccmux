import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/config/sessions.ts';
import { type Observed, observeOnce } from '../src/events/observe.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { MonitoringReadSchema } from '../src/monitoring/schema.ts';
import { observationChildCpuUs, observationExecCount } from '../src/monitoring/tmux.ts';

// Read-only live pane workload. Its archived registry copy prevents lifecycle repair/events;
// no ensure, chat delivery, supervisor or managed process is started by this harness.
const seconds = Number(Bun.argv[2] ?? 900);
if (!Number.isFinite(seconds) || seconds < 1) throw new Error('positive duration required');
const actual = loadMachineConfig();
const dir = mkdtempSync(join(tmpdir(), 'ccmux-status-bench-'));
const machine = { ...actual, stateDir: dir, sessionEvents: false };
const config = join(dir, 'machine.json');
await Bun.write(config, JSON.stringify(machine));
const cli = join(import.meta.dir, '../src/cli.ts');
const publisher = new MonitoringPublisher();
const previous = new Map<string, Observed>();
const latencies: number[] = [];
const ages: number[] = [];
let readerCpuUs = 0;
let reads = 0;
let passes = 0;
let rows = 0;
let maxRss = 0;
const started = Date.now();
const cpuStart = process.cpuUsage();

async function read(): Promise<string> {
  const at = performance.now();
  const proc = Bun.spawn([process.execPath, cli, 'status', '--json'], {
    env: { ...process.env, CCMUX_CONFIG: config },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`read failed: ${stderr} ${stdout}`);
  readerCpuUs += Number(proc.resourceUsage()?.cpuTime.total ?? 0);
  const result = MonitoringReadSchema.parse(JSON.parse(stdout));
  if (result.status !== 'live' || result.snapshot === null) throw new Error('not live');
  latencies.push(performance.now() - at);
  ages.push(Date.now() - Date.parse(result.snapshot.observedAt));
  reads++;
  return `${result.snapshot.generation}:${result.snapshot.sequence}`;
}

while (Date.now() - started < seconds * 1000) {
  await writeSessionsUnlocked(
    machine,
    loadSessions(actual).map((session) => ({ ...session, archived: true })),
  );
  publisher.begin(machine);
  await observeOnce(machine, previous, Date.now(), publisher.sample);
  const snapshot = await publisher.publish(machine);
  rows = snapshot.sessions.length;
  passes++;
  const pair = await Promise.all([read(), read()]);
  if (pair[0] !== pair[1]) throw new Error('simultaneous readers observed different generations');
  if (passes === 1)
    for (let i = 0; i < 10; i++) await Promise.all(Array.from({ length: 10 }, () => read()));
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
  if (passes % 15 === 0)
    console.log(
      JSON.stringify({
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        reads,
        passes,
        rows,
      }),
    );
  await Bun.sleep(2000);
}
publisher.stop();
const cpu = process.cpuUsage(cpuStart);
const percentile = (values: number[], p: number): number =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
const result = {
  elapsedMs: Date.now() - started,
  reads,
  passes,
  rows,
  producerCpuMs: (cpu.user + cpu.system) / 1000,
  producerChildCpuMs: observationChildCpuUs() / 1000,
  readerCpuIncludingChildrenMs: readerCpuUs / 1000,
  observationExecs: observationExecCount(),
  readerExecs: reads,
  latencyP50Ms: percentile(latencies, 0.5),
  latencyP95Ms: percentile(latencies, 0.95),
  freshnessP95Ms: percentile(ages, 0.95),
  freshnessMaxMs: Math.max(...ages),
  maxRssBytes: maxRss,
};
await Bun.write(join(dir, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
