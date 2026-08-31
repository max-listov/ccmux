import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitoringStatusPath } from '../src/config/paths.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { projectMonitoringRow } from '../src/monitoring/project.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { readMonitoringStatus } from '../src/monitoring/read.ts';
import {
  MonitoringReadSchema,
  STATUS_MAX_BYTES,
  STATUS_MAX_ITEMS,
} from '../src/monitoring/schema.ts';
import {
  observationExecCount,
  observedPane,
  observedSessionInventory,
} from '../src/monitoring/tmux.ts';
import { MtimeCache } from '../src/util/mtimeCache.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('lifecycle blocks are identity-pinned and never leak their error into the monitoring DTO', () => {
  const m = fixture();
  const s = makeSession();
  mkdirSync(join(m.stateDir, 'lifecycle-blocks'));
  const path = join(m.stateDir, 'lifecycle-blocks', `${s.name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      name: s.name,
      agent: s.agent,
      uuid: s.uuid,
      error: 'internal detail',
      at: new Date().toISOString(),
    }),
  );
  const blocked = projectMonitoringRow(m, s, undefined, null, UNSEEN);
  expect(blocked.state).toBe('blocked');
  expect(JSON.stringify(blocked)).not.toContain('internal detail');
  const renewed = makeSession({ uuid: '22222222-2222-4222-8222-222222222222' });
  expect(projectMonitoringRow(m, renewed, undefined, null, UNSEEN).state).toBe('stopped');
});

test('snapshot symlinks and FIFOs cannot turn a bounded read into an arbitrary or blocking read', () => {
  const m = fixture();
  const target = join(m.stateDir, 'target');
  writeFileSync(target, '{}');
  symlinkSync(target, monitoringStatusPath(m));
  expect(readMonitoringStatus(m).status).toBe('unavailable');
  rmSync(monitoringStatusPath(m));
  expect(Bun.spawnSync(['mkfifo', monitoringStatusPath(m)]).exitCode).toBe(0);
  const at = performance.now();
  expect(readMonitoringStatus(m).status).toBe('unavailable');
  expect(performance.now() - at).toBeLessThan(100);
});

const dirs: string[] = [];
test('producer inventory uses printable delimiters under a service locale', async () => {
  const m = fixture();
  const script = join(m.stateDir, 'inventory');
  writeFileSync(
    script,
    "#!/bin/sh\ncase \"$3\" in\n  '#{session_name} #{session_created}') printf 'agent-a 123\\n';;\n  *) printf 'agent-a_123\\n';;\nesac\n",
    { mode: 0o700 },
  );
  m.tmuxBin = script;
  expect([...(await observedSessionInventory(m))]).toEqual([['agent-a', 123]]);
});
test('managed status distinguishes work, idle, prompt, unknown and stopped', () => {
  const m = fixture();
  const s = makeSession();
  const row = (pane: string | null) => projectMonitoringRow(m, s, 1, pane, UNSEEN);
  expect(row('✳ Computing…\nesc to interrupt').state).toBe('working');
  expect(row('❯\n? for shortcuts').state).toBe('idle');
  expect(row(null).state).toBe('unknown');
  expect(row('starting').state).toBe('unknown');
  expect(projectMonitoringRow(m, s, undefined, null, UNSEEN)).toMatchObject({
    state: 'stopped',
    running: false,
    model: null,
    contextPercent: null,
    uptimeSeconds: null,
    lastActivityAt: null,
  });
  expect(
    row('Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n2. No, exit').state,
  ).toBe('prompt');
});

test('metadata cache bounds retained bytes and invalidates inode replacement', () => {
  const m = fixture();
  const file = join(m.stateDir, 'data');
  writeFileSync(file, 'a');
  const at = new Date(100000);
  utimesSync(file, at, at);
  const cache = new MtimeCache<string>(1024, 2);
  expect(cache.get(file, () => 'first')).toBe('first');
  expect(cache.get(file, () => 'wrong')).toBe('first');
  const next = join(m.stateDir, 'next');
  writeFileSync(next, 'b');
  utimesSync(next, at, at);
  renameSync(next, file);
  expect(cache.get(file, () => 'second')).toBe('second');
  for (let i = 0; i < 10; i++) {
    const path = join(m.stateDir, String(i));
    writeFileSync(path, 'x');
    cache.get(path, () => 'x'.repeat(100));
    expect(cache.retainedBytes).toBeLessThanOrEqual(1024);
  }
  rmSync(file);
  expect(cache.get(file, () => 'bad')).toBeNull();
});

test('failed tmux inventory is unavailable, capture failure is unknown, and hanging child is bounded', async () => {
  const m = fixture();
  m.tmuxBin = '/usr/bin/false';
  await expect(observedSessionInventory(m)).rejects.toThrow('unavailable');
  expect(await observedPane(m, 'agent-a')).toBeNull();
  const script = join(m.stateDir, 'hang');
  writeFileSync(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
  m.tmuxBin = script;
  const at = performance.now();
  await expect(observedSessionInventory(m)).rejects.toThrow('unavailable');
  expect(performance.now() - at).toBeLessThan(2500);
});
test('row and byte limits report omissions', async () => {
  const m = fixture();
  const p = new MonitoringPublisher();
  p.begin(m);
  for (let i = 0; i < 300; i++)
    p.sample(m, makeSession({ name: `agent-${i}`, dir: m.stateDir }), undefined, null, UNSEEN);
  const full = await p.publish(m);
  expect(full.sessions.length).toBe(STATUS_MAX_ITEMS);
  expect(full.omitted).toBe(44);
  expect(full.sessions.every((row) => row.dir === m.stateDir)).toBe(true);
  p.begin(m);
  for (let i = 0; i < 300; i++)
    p.sample(
      m,
      makeSession({ name: `agent-${i}`, dir: `/${'x'.repeat(8000)}` }),
      undefined,
      null,
      UNSEEN,
    );
  const bounded = await p.publish(m);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(STATUS_MAX_BYTES);
  expect(bounded.sessions.length + bounded.omitted).toBe(300);
  expect(bounded.sessions.length).toBeLessThan(STATUS_MAX_ITEMS);
});
test('producer rejects oversized output and counts invalid identities without truncation', async () => {
  const m = fixture();
  const script = join(m.stateDir, 'oversized');
  writeFileSync(script, '#!/bin/sh\nexec head -c 70000 /dev/zero\n', { mode: 0o700 });
  m.tmuxBin = script;
  await expect(observedPane(m, 'agent-a')).rejects.toThrow('output limit');
  const p = new MonitoringPublisher();
  p.begin(m);
  p.sample(m, makeSession({ name: 'x'.repeat(257) }), undefined, null, UNSEEN);
  const snapshot = await p.publish(m);
  expect(snapshot.sessions).toEqual([]);
  expect(snapshot.omitted).toBe(1);
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-monitoring-'));
  dirs.push(dir);
  return makeMachine({ stateDir: dir, projectsDir: join(dir, 'history'), rcPrefix: 'host-a' });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('100 readers reuse a single observation without any observation subprocess', async () => {
  const m = fixture();
  const p = new MonitoringPublisher();
  p.begin(m);
  p.sample(m, makeSession(), undefined, null, UNSEEN);
  const published = await p.publish(m);
  const execs = observationExecCount();
  for (let i = 0; i < 100; i++) {
    const read = MonitoringReadSchema.parse(readMonitoringStatus(m));
    expect(read.status).toBe('live');
    expect(read.snapshot).toEqual(published);
    expect(JSON.stringify(read)).not.toContain('lastMessage');
  }
  expect(observationExecCount()).toBe(execs);
});

test('unavailable/stale snapshots never masquerade as empty live inventory', async () => {
  const m = fixture();
  expect(readMonitoringStatus(m)).toMatchObject({
    status: 'unavailable',
    reason: 'missing',
    snapshot: null,
  });
  const p = new MonitoringPublisher();
  p.begin(m);
  const s = await p.publish(m);
  expect(readMonitoringStatus(m, Date.parse(s.observedAt) + 10001)).toMatchObject({
    status: 'stale',
    snapshot: null,
  });
  expect(readMonitoringStatus(m, Date.parse(s.observedAt) - 1).reason).toBe('clock-skew');
  writeFileSync(monitoringStatusPath(m), '{');
  expect(readMonitoringStatus(m).reason).toBe('invalid');
  writeFileSync(monitoringStatusPath(m), ' '.repeat(STATUS_MAX_BYTES + 1));
  expect(readMonitoringStatus(m).reason).toBe('oversized');
  writeFileSync(monitoringStatusPath(m), JSON.stringify({ ...s, pid: 2147483647 }));
  expect(readMonitoringStatus(m).reason).toBe('producer-stopped');
});

test('new, removed and restarted identities replace the complete bounded snapshot', async () => {
  const m = fixture();
  const p = new MonitoringPublisher();
  p.begin(m);
  p.sample(m, makeSession(), undefined, null, UNSEEN);
  const first = await p.publish(m);
  p.begin(m);
  const replacement = makeSession({ agent: 'codex', uuid: '22222222-2222-4222-8222-222222222222' });
  p.sample(m, replacement, undefined, null, UNSEEN);
  const next = await p.publish(m);
  expect(next.sequence).toBe(first.sequence + 1);
  expect(next.sessions[0]?.uuid).toBe(replacement.uuid);
  expect(next.sessions[0]?.agent).toBe('codex');
  p.begin(m);
  expect((await p.publish(m)).sessions).toEqual([]);
  p.stop();
  expect(readMonitoringStatus(m).reason).toBe('missing');
  const restarted = new MonitoringPublisher();
  restarted.begin(m);
  expect((await restarted.publish(m)).generation).not.toBe(first.generation);
});
