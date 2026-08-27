import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMonitoringStatus, MONITORING_MAX_READERS, STATUS_MAX_BYTES } from "../src/monitoring-reader.ts";
import { MonitoringPublisher } from "../src/monitoring/publish.ts";
import { monitoringStatusPath } from "../src/config/paths.ts";
import { observationExecCount } from "../src/monitoring/tmux.ts";
import { UNSEEN } from "../src/events/observe.ts";
import { makeMachine, makeSession } from "./helpers.ts";

let root: string;
let previousConfig: string | undefined;
let previousPrefix: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-native-"));
  previousConfig = process.env.CCMUX_CONFIG;
  previousPrefix = process.env.CCMUX_RC_PREFIX;
  process.env.CCMUX_CONFIG = join(root, "machine.json");
  delete process.env.CCMUX_RC_PREFIX;
});
afterEach(async () => {
  // Allow cancelled file reads to release their handles before deleting the isolated fixture.
  await Bun.sleep(20);
  if (previousConfig === undefined) delete process.env.CCMUX_CONFIG;
  else process.env.CCMUX_CONFIG = previousConfig;
  if (previousPrefix === undefined) delete process.env.CCMUX_RC_PREFIX;
  else process.env.CCMUX_RC_PREFIX = previousPrefix;
  rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const machine = makeMachine({ rcPrefix: "host-a", stateDir: root });
  writeFileSync(join(root, "machine.json"), JSON.stringify(machine));
  const publisher = new MonitoringPublisher();
  publisher.begin(machine);
  publisher.sample(machine, makeSession(), undefined, null, UNSEEN);
  const snapshot = await publisher.publish(machine);
  return { machine, publisher, snapshot, path: monitoringStatusPath(machine) };
}

test("public native API: 100 sequential and 100 concurrent reads reuse one published observation", async () => {
  const { snapshot } = await fixture();
  const before = observationExecCount();
  for (let i = 0; i < 100; i++) expect((await readMonitoringStatus()).snapshot).toEqual(snapshot);
  const reads = await Promise.all(Array.from({ length: 100 }, () => readMonitoringStatus({ timeoutMs: 1000 })));
  for (const read of reads) expect(read.snapshot).toEqual(snapshot);
  expect(observationExecCount()).toBe(before);
  // Callers cannot corrupt the shared result delivered to other callers.
  if (reads[0]?.snapshot) reads[0].snapshot.sessions.length = 0;
  expect(reads[1]?.snapshot?.sessions.length).toBe(1);
  expect((await readMonitoringStatus()).snapshot).toEqual(snapshot);
});

test("native capacity, independent abort, invalid deadline and no retention of completed data", async () => {
  await fixture();
  const stop = new AbortController();
  stop.abort();
  expect((await readMonitoringStatus({ signal: stop.signal })).reason).toBe("cancelled");
  expect((await readMonitoringStatus({ timeoutMs: Infinity })).reason).toBe("invalid");
  expect((await Reflect.apply(readMonitoringStatus, null, [{ path: "/arbitrary", refresh: true }])).reason).toBe("invalid");
  const activeStop = new AbortController();
  const cancelled = readMonitoringStatus({ signal: activeStop.signal });
  activeStop.abort();
  expect((await cancelled).reason).toBe("cancelled");
  const reads = Array.from({ length: MONITORING_MAX_READERS }, () => readMonitoringStatus({ timeoutMs: 1000 }));
  expect((await readMonitoringStatus()).reason).toBe("busy");
  expect((await Promise.all(reads)).every((read) => read.status === "live")).toBe(true);
});

test("native malformed, oversized, stale, mismatched and dead-producer snapshots fail closed", async () => {
  const { snapshot, path } = await fixture();
  const check = async (value: string, reason: string) => {
    writeFileSync(path, value);
    expect(await readMonitoringStatus()).toMatchObject({ reason, snapshot: null });
  };
  await check("{", "invalid");
  await check(" ".repeat(STATUS_MAX_BYTES + 1), "oversized");
  await check(JSON.stringify({ ...snapshot, observedAt: new Date(Date.now() - 11000).toISOString() }), "expired");
  await check(JSON.stringify({ ...snapshot, observedAt: new Date(Date.now() + 11000).toISOString() }), "clock-skew");
  await check(JSON.stringify({ ...snapshot, rcPrefix: "host-b" }), "invalid");
  await check(JSON.stringify({ ...snapshot, pid: 2147483647 }), "producer-stopped");
  rmSync(path);
  expect((await readMonitoringStatus()).reason).toBe("missing");
});

test("native discovery follows root/config changes and replaces identities/removals without caches", async () => {
  const { machine, publisher, snapshot } = await fixture();
  expect((await readMonitoringStatus()).snapshot?.generation).toBe(snapshot.generation);
  const stateDir = join(root, "new-state"); mkdirSync(stateDir);
  const nextMachine = { ...machine, stateDir };
  writeFileSync(join(root, "machine.json"), JSON.stringify(nextMachine));
  expect((await readMonitoringStatus()).reason).toBe("missing");
  const next = new MonitoringPublisher(); next.begin(nextMachine);
  next.sample(nextMachine, makeSession({ agent: "codex", uuid: "22222222-2222-4222-8222-222222222222" }), undefined, null, UNSEEN);
  await next.publish(nextMachine);
  const read = await readMonitoringStatus();
  expect(read.snapshot?.generation).not.toBe(snapshot.generation);
  expect(read.snapshot?.sessions[0]?.agent).toBe("codex");
  next.begin(nextMachine); await next.publish(nextMachine);
  expect((await readMonitoringStatus()).snapshot?.sessions).toEqual([]);
  publisher.stop(); // Old producer cannot remove the new root's data.
  expect((await readMonitoringStatus()).status).toBe("live");
  next.stop(); expect((await readMonitoringStatus()).reason).toBe("missing");
});

test("native refuses unsafe permissions, symlinks, FIFOs and oversized/invalid configuration", async () => {
  const { path } = await fixture();
  chmodSync(path, 0o666);
  expect((await readMonitoringStatus()).reason).toBe("unauthorized");
  rmSync(path); symlinkSync(join(root, "machine.json"), path);
  expect((await readMonitoringStatus()).reason).toBe("read-failed");
  rmSync(path);
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  expect((await readMonitoringStatus()).reason).toBe("invalid");
  writeFileSync(join(root, "machine.json"), " ".repeat(128 * 1024 + 1));
  expect((await readMonitoringStatus()).reason).toBe("oversized");
  writeFileSync(join(root, "machine.json"), "{");
  expect((await readMonitoringStatus()).reason).toBe("invalid");
});

for (const mode of ["hang", "migration"]) {
  test(`isolated native I/O ${mode}: bounded deadlines, cancellation and configuration race`, async () => {
    await fixture();
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/monitoring-native-io.ts"), mode], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const [output, errors, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
    expect(output).toContain("native I/O proof OK");
  });
}
