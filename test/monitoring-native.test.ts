import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitoringStatusPath } from '../src/config/paths.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { observationExecCount } from '../src/monitoring/tmux.ts';
import {
  MONITORING_MAX_READERS,
  readMonitoringStatus,
  STATUS_MAX_BYTES,
} from '../src/monitoring-reader.ts';
import { makeMachine, makeSession } from './helpers.ts';

let root: string;
let previousConfig: string | undefined;
let previousPrefix: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccmux-native-'));
  previousConfig = process.env.CCMUX_CONFIG;
  previousPrefix = process.env.CCMUX_RC_PREFIX;
  process.env.CCMUX_CONFIG = join(root, 'machine.json');
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
  const machine = makeMachine({ rcPrefix: 'host-a', stateDir: root });
  writeFileSync(join(root, 'machine.json'), JSON.stringify(machine));
  const publisher = new MonitoringPublisher();
  publisher.begin(machine);
  publisher.sample(machine, makeSession(), undefined, null, UNSEEN);
  const snapshot = await publisher.publish(machine);
  return { machine, publisher, snapshot, path: monitoringStatusPath(machine) };
}

test('public native API: 100 sequential and 100 concurrent reads reuse one published observation', async () => {
  const { snapshot } = await fixture();
  const before = observationExecCount();
  // Assert on status and reason together with the snapshot, never on the snapshot alone. Five
  // different outcomes hand back `null` here — missing, invalid, oversized, expired, producer
  // stopped — and a bare `toEqual(snapshot)` prints all five as the same thirty-eight-line diff
  // against `null`, which names none of them. A failure has to say WHICH, or the next reader
  // starts by guessing, and a guess about the cause is where the wrong fix comes from.
  const live = (read: Awaited<ReturnType<typeof readMonitoringStatus>>) => ({
    status: read.status,
    reason: read.reason,
    snapshot: read.snapshot,
  });
  const expected = { status: 'live' as const, reason: null, snapshot };
  // This case is about REUSE — how many observations two hundred callers cause — and not about how
  // fast the machine is. The reader's own timeout is capped at one second and cannot be raised, so
  // on a loaded box a caller legitimately answers `deadline` and the case failed for something it
  // does not test. A deadline is this reader's honest answer and is taken again; anything else
  // still fails, and the observation count still spans every read, so a retry cannot hide a reader
  // that stopped reusing. The deadline behaviour itself is proven in the case below.
  const again = async (read: Awaited<ReturnType<typeof readMonitoringStatus>>) =>
    read.reason === 'deadline' ? await readMonitoringStatus({ timeoutMs: 1000 }) : read;
  for (let i = 0; i < 100; i++)
    expect(live(await again(await readMonitoringStatus()))).toEqual(expected);
  const reads = await Promise.all(
    (
      await Promise.all(
        Array.from({ length: 100 }, () => readMonitoringStatus({ timeoutMs: 1000 })),
      )
    ).map(again),
  );
  for (const read of reads) expect(live(read)).toEqual(expected);
  expect(observationExecCount()).toBe(before);
  // Callers cannot corrupt the shared result delivered to other callers.
  if (reads[0]?.snapshot) reads[0].snapshot.sessions.length = 0;
  expect(reads[1]?.snapshot?.sessions.length).toBe(1);
  expect((await readMonitoringStatus()).snapshot).toEqual(snapshot);
});

test('native capacity, independent abort, invalid deadline and no retention of completed data', async () => {
  await fixture();
  const stop = new AbortController();
  stop.abort();
  expect((await readMonitoringStatus({ signal: stop.signal })).reason).toBe('cancelled');
  expect((await readMonitoringStatus({ timeoutMs: Infinity })).reason).toBe('invalid');
  expect(
    (await Reflect.apply(readMonitoringStatus, null, [{ path: '/arbitrary', refresh: true }]))
      .reason,
  ).toBe('invalid');
  const activeStop = new AbortController();
  const cancelled = readMonitoringStatus({ signal: activeStop.signal });
  activeStop.abort();
  expect((await cancelled).reason).toBe('cancelled');
  // Capacity, for the same reason and with the same remedy as the reuse case above: the one caller
  // past the cap must be refused as `busy`, and the readers inside it must all be served. A reader
  // answering `deadline` on a loaded machine is not a capacity failure, and its timeout cannot be
  // raised, so the probe is taken again rather than counted as one.
  const saturate = async () => {
    const inFlight = Array.from({ length: MONITORING_MAX_READERS }, () =>
      readMonitoringStatus({ timeoutMs: 1000 }),
    );
    const refused = (await readMonitoringStatus()).reason;
    return { refused, served: await Promise.all(inFlight) };
  };
  let { refused, served } = await saturate();
  if (served.some((read) => read.reason === 'deadline')) ({ refused, served } = await saturate());
  expect(refused).toBe('busy');
  expect(served.every((read) => read.status === 'live')).toBe(true);
});

test('native malformed, oversized, stale, mismatched and dead-producer snapshots fail closed', async () => {
  const { snapshot, path } = await fixture();
  const check = async (value: string, reason: string) => {
    writeFileSync(path, value);
    expect(await readMonitoringStatus()).toMatchObject({ reason, snapshot: null });
  };
  await check('{', 'invalid');
  await check(' '.repeat(STATUS_MAX_BYTES + 1), 'oversized');
  await check(
    JSON.stringify({ ...snapshot, observedAt: new Date(Date.now() - 11000).toISOString() }),
    'expired',
  );
  await check(
    JSON.stringify({ ...snapshot, observedAt: new Date(Date.now() + 11000).toISOString() }),
    'clock-skew',
  );
  await check(JSON.stringify({ ...snapshot, rcPrefix: 'host-b' }), 'invalid');
  await check(JSON.stringify({ ...snapshot, pid: 2147483647 }), 'producer-stopped');
  rmSync(path);
  expect((await readMonitoringStatus()).reason).toBe('missing');
});

test('native discovery follows root/config changes and replaces identities/removals without caches', async () => {
  const { machine, publisher, snapshot } = await fixture();
  expect((await readMonitoringStatus()).snapshot?.generation).toBe(snapshot.generation);
  const stateDir = join(root, 'new-state');
  mkdirSync(stateDir);
  const nextMachine = { ...machine, stateDir };
  writeFileSync(join(root, 'machine.json'), JSON.stringify(nextMachine));
  expect((await readMonitoringStatus()).reason).toBe('missing');
  const next = new MonitoringPublisher();
  next.begin(nextMachine);
  next.sample(
    nextMachine,
    makeSession({ agent: 'codex', uuid: '22222222-2222-4222-8222-222222222222' }),
    undefined,
    null,
    UNSEEN,
  );
  await next.publish(nextMachine);
  const read = await readMonitoringStatus();
  expect(read.snapshot?.generation).not.toBe(snapshot.generation);
  expect(read.snapshot?.sessions[0]?.agent).toBe('codex');
  next.begin(nextMachine);
  await next.publish(nextMachine);
  expect((await readMonitoringStatus()).snapshot?.sessions).toEqual([]);
  publisher.stop(); // Old producer cannot remove the new root's data.
  expect((await readMonitoringStatus()).status).toBe('live');
  next.stop();
  expect((await readMonitoringStatus()).reason).toBe('missing');
});

test('native refuses unsafe permissions, symlinks, FIFOs and oversized/invalid configuration', async () => {
  const { path } = await fixture();
  chmodSync(path, 0o666);
  expect((await readMonitoringStatus()).reason).toBe('unauthorized');
  rmSync(path);
  symlinkSync(join(root, 'machine.json'), path);
  expect((await readMonitoringStatus()).reason).toBe('read-failed');
  rmSync(path);
  expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
  expect((await readMonitoringStatus()).reason).toBe('invalid');
  writeFileSync(join(root, 'machine.json'), ' '.repeat(128 * 1024 + 1));
  expect((await readMonitoringStatus()).reason).toBe('oversized');
  writeFileSync(join(root, 'machine.json'), '{');
  expect((await readMonitoringStatus()).reason).toBe('invalid');
});

for (const mode of ['hang', 'migration']) {
  test(`isolated native I/O ${mode}: bounded deadlines, cancellation and configuration race`, async () => {
    await fixture();
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'fixtures/monitoring-native-io.ts'), mode],
      {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [output, errors, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: '' });
    expect(output).toContain('native I/O proof OK');
  });
}
