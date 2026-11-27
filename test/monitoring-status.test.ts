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
import { dirname, join } from 'node:path';
import { claudeProvider } from '../src/agent/claude/index.ts';
import { histFile } from '../src/agent/claude/resume.ts';
import { lastActivityMs, lastTranscriptMessage, transcriptMtimeMs } from '../src/agent/index.ts';
import { readTurnState } from '../src/chat/turnProgress.ts';
import { monitoringStatusPath } from '../src/config/paths.ts';
import { inventoryRow } from '../src/events/inventory.ts';
import { observe, UNSEEN } from '../src/events/observe.ts';
import { collectRows } from '../src/inventory/rows.ts';
import { projectMonitoringRow } from '../src/monitoring/project.ts';
import { MonitoringPublisher } from '../src/monitoring/publish.ts';
import { readMonitoringStatus } from '../src/monitoring/read.ts';
import {
  MonitoringReadSchema,
  STATUS_MAX_BYTES,
  STATUS_MAX_ITEMS,
} from '../src/monitoring/schema.ts';
import { observedPane, observedSessionInventory } from '../src/monitoring/tmux.ts';
import { ManagedRuntimeStatusWriter } from '../src/runtime/status.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { clearWaiting, writeLifecycle, writeWaiting } from '../src/session/status.ts';
import { MtimeCache } from '../src/util/mtimeCache.ts';
import { makeMachine, makeSession, producerMetric } from './helpers.ts';

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
  // What is asserted is the parse, not the speed of spawning a shell. Under a loaded full-suite
  // run the child lost the production deadline, and the failure read as "the delimiter is wrong".
  process.env.CCMUX_OBSERVE_DEADLINE_MS = '15000';
  const m = fixture();
  const script = join(m.stateDir, 'inventory');
  writeFileSync(
    script,
    "#!/bin/sh\ncase \"$5\" in\n  '#{session_name}|#{pane_id}|#{@ccmux-agent-pane}|#{session_created}|#{pane_pid}|#{pid}|#{pane_height}') printf 'agent-a|%%1|%%1|123|100|200|24\\n';;\n  *) printf 'agent-a_123\\n';;\nesac\n",
    { mode: 0o700 },
  );
  m.tmuxBin = script;
  try {
    expect([...(await observedSessionInventory(m))]).toEqual([['agent-a', 123]]);
  } finally {
    delete process.env.CCMUX_OBSERVE_DEADLINE_MS;
  }
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
    startedAt: null,
    lastActivityAt: null,
  });
  expect(
    row('Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n2. No, exit').state,
  ).toBe('prompt');
});

test('monitoring rows expose structural step matching inventory and waitingFor without message text', async () => {
  const m = fixture();
  const s = makeSession({ name: `step-${crypto.randomUUID()}`, dir: m.stateDir });
  const history = histFile(s.dir, s.uuid, m.projectsDir);
  mkdirSync(dirname(history), { recursive: true });
  const stepAt = '2026-11-25T04:40:00.000Z';
  writeFileSync(
    history,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: stepAt,
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'echo secret-payload-never-in-monitoring' },
          },
        ],
      },
    })}\n`,
  );

  // Working Claude session: structural step matches inventoryRow and omits all message/tool text.
  const working = projectMonitoringRow(m, s, 1, '✳ Computing…\nesc to interrupt', UNSEEN);
  const inv = inventoryRow(working, 1, lastTranscriptMessage(s, m));
  expect(working.step).toEqual({
    kind: 'tool_call',
    role: 'assistant',
    toolName: 'Bash',
    at: stepAt,
  });
  expect(working.step).toEqual(inv.step);
  expect(working.atPrompt).toBeNull();
  expect(working.waitingFor).toBeNull();
  expect(JSON.stringify(working)).not.toContain('secret-payload-never-in-monitoring');

  // Idle session (transcript aged past the turn quiet window): retains last structural step and clears waits.
  const idle = projectMonitoringRow(
    m,
    s,
    1,
    '❯\n? for shortcuts',
    UNSEEN,
    Date.now() + 10 * 60_000,
  );
  expect(idle.state).toBe('idle');
  expect(idle.step).toEqual(working.step);
  expect(idle.atPrompt).toBeNull();
  expect(idle.waitingFor).toBeNull();

  const fresh = makeSession({
    name: `fresh-${crypto.randomUUID()}`,
    uuid: '33333333-3333-4333-8333-333333333333',
    dir: m.stateDir,
  });
  const idleEmpty = projectMonitoringRow(m, fresh, 1, '❯\n? for shortcuts', UNSEEN);
  expect(idleEmpty.step).toBeNull();
  expect(idleEmpty.atPrompt).toBeNull();
  expect(idleEmpty.waitingFor).toBeNull();

  // Stopped session: step, atPrompt and waitingFor are null.
  const stopped = projectMonitoringRow(m, s, undefined, null, UNSEEN);
  expect(stopped.step).toBeNull();
  expect(stopped.atPrompt).toBeNull();
  expect(stopped.waitingFor).toBeNull();

  // Selection menu: state is prompt and atPrompt names the blocking menu (distinct from waitingFor).
  const atMenu = projectMonitoringRow(
    m,
    s,
    1,
    'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n2. No, exit',
    UNSEEN,
  );
  expect(atMenu.state).toBe('prompt');
  expect(atMenu.atPrompt).toBe('trust this folder');
  expect(atMenu.waitingFor).toBeNull();

  // Declared session wait populates waitingFor without conflating it with atPrompt.
  const now = Date.now();
  await writeWaiting(s.name, {
    target: 'host-b:agent-b',
    since: now,
    pid: process.pid,
    expiresAt: now + 60_000,
  });
  try {
    const waiting = projectMonitoringRow(m, s, 1, '❯\n? for shortcuts', UNSEEN, now);
    expect(waiting.atPrompt).toBeNull();
    expect(waiting.waitingFor).toBe('host-b:agent-b');
  } finally {
    clearWaiting(s.name);
  }
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
  // The limit is what must end this read, not the one-second deadline: a loaded host can spend that
  // second starting the shell, and a timeout resolves the read instead of rejecting it.
  const previous = process.env.CCMUX_OBSERVE_DEADLINE_MS;
  process.env.CCMUX_OBSERVE_DEADLINE_MS = '30000';
  try {
    await expect(observedPane(m, 'agent-a')).rejects.toThrow('output limit');
  } finally {
    if (previous === undefined) delete process.env.CCMUX_OBSERVE_DEADLINE_MS;
    else process.env.CCMUX_OBSERVE_DEADLINE_MS = previous;
  }
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
  const execs = producerMetric('observation').execCount ?? 0;
  for (let i = 0; i < 100; i++) {
    const read = MonitoringReadSchema.parse(readMonitoringStatus(m));
    expect(read.status).toBe('live');
    expect(read.snapshot).toEqual(published);
    expect(JSON.stringify(read)).not.toContain('lastMessage');
  }
  expect(producerMetric('observation').execCount ?? 0).toBe(execs);
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

test('lastActivityAt tracks last real conversation message past >120 bookkeeping lines and resume notices, separate from startedAt and file mtime', async () => {
  const m = fixture();
  const s = makeSession({ name: `bookkeeping-${crypto.randomUUID()}`, dir: m.stateDir });
  const history = histFile(s.dir, s.uuid, m.projectsDir);
  mkdirSync(dirname(history), { recursive: true });
  const replyAt = '2026-10-13T12:11:11.000Z';
  const resumeAt = '2026-11-25T17:34:29.000Z';
  const mtimeAt = new Date('2026-11-26T10:00:00.000Z');
  const bookkeeping = [
    'bridge-session',
    'cost-state',
    'atis-latch',
    'data-flow-records',
    'derived-from',
    'tools-used',
  ];
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: replyAt,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'real conversation reply' }],
      },
    }),
    // Batched orphan-shell notification emitted on SessionStart:resume (no <tool-use-id>).
    JSON.stringify({
      type: 'user',
      timestamp: resumeAt,
      message: {
        role: 'user',
        content:
          '<task-notification>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell tasks stopped</summary>\n</task-notification>',
      },
    }),
    ...Array.from({ length: 180 }, (_, index) =>
      JSON.stringify({ type: bookkeeping[index % bookkeeping.length], seq: index }),
    ),
  ];
  writeFileSync(history, `${lines.join('\n')}\n`);
  utimesSync(history, mtimeAt, mtimeAt);

  const startedSec = Math.floor(Date.parse('2026-11-25T17:34:05.000Z') / 1000);
  const now = Date.parse('2026-11-26T14:00:00.000Z');
  const row = projectMonitoringRow(m, s, startedSec, '❯\n? for shortcuts', UNSEEN, now);
  expect(row.lastActivityAt).toBe(replyAt);
  expect(row.startedAt).toBe('2026-11-25T17:34:05.000Z');
  expect(row.uptimeSeconds).toBe(Math.floor(now / 1000 - startedSec));
  expect(lastActivityMs(s, m)).toBe(Date.parse(replyAt));
  expect(transcriptMtimeMs(s, m)).toBe(mtimeAt.getTime());

  // Stopped sessions retain their real conversation lastActivityAt with null startedAt/step.
  const stopped = projectMonitoringRow(m, s, undefined, null, UNSEEN, now);
  expect(stopped.lastActivityAt).toBe(replyAt);
  expect(stopped.startedAt).toBeNull();
  expect(stopped.uptimeSeconds).toBeNull();
  expect(stopped.step).toBeNull();

  // Inventory rows use the same real conversation timestamp rather than file mtime.
  await writeSessionsUnlocked(m, [s]);
  const [invRow] = await collectRows(m, {
    only: s.name,
    observation: {
      created: new Map([[s.name, startedSec]]),
      agentPanes: new Map(),
      panes: new Map([[s.name, '❯\n? for shortcuts']]),
    },
  });
  expect(invRow?.lastActivityMs).toBe(Date.parse(replyAt));

  // A session whose transcript holds only bookkeeping lines reports null lastActivityAt (never mtime).
  const silent = makeSession({
    name: `silent-${crypto.randomUUID()}`,
    uuid: '44444444-4444-4444-8444-444444444444',
    dir: m.stateDir,
  });
  const silentPath = histFile(silent.dir, silent.uuid, m.projectsDir);
  writeFileSync(
    silentPath,
    `${JSON.stringify({ type: 'custom-title', customTitle: 'host-a-silent' })}\n${JSON.stringify({ type: 'bridge-session' })}\n`,
  );
  const silentRow = projectMonitoringRow(m, silent, startedSec, '❯\n? for shortcuts', UNSEEN, now);
  expect(silentRow.lastActivityAt).toBeNull();
  expect(silentRow.startedAt).toBe('2026-11-25T17:34:05.000Z');

  // Folded tool_call uses the later tool_result completion time (doneAt) as lastActivityAt.
  const folded = makeSession({
    name: `folded-${crypto.randomUUID()}`,
    uuid: '55555555-5555-4555-8555-555555555555',
    dir: m.stateDir,
  });
  const foldedPath = histFile(folded.dir, folded.uuid, m.projectsDir);
  writeFileSync(
    foldedPath,
    `${[
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-25T01:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'true' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-11-25T01:04:30.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }],
        },
      }),
    ].join('\n')}\n`,
  );
  expect(
    projectMonitoringRow(m, folded, startedSec, '❯\n? for shortcuts', UNSEEN, now).lastActivityAt,
  ).toBe('2026-11-25T01:04:30.000Z');
});

test('active turn liveness in observe and readTurnState still uses file mtime independently of old message timestamps', async () => {
  const m = fixture();
  const s = makeSession({ name: `turn-${crypto.randomUUID()}`, dir: m.stateDir });
  const history = histFile(s.dir, s.uuid, m.projectsDir);
  mkdirSync(dirname(history), { recursive: true });
  const turnStart = Date.parse('2026-11-26T12:00:00.000Z');
  // 50s into the turn the file was written, so 20s later (70s past turnStart, > 60s threshold)
  // ONLY file mtime proves the turn is still alive — an old message timestamp would prematurely close it.
  const fileWrite = turnStart + 50_000;
  writeFileSync(
    history,
    `${[
      JSON.stringify({
        type: 'user',
        timestamp: '2026-11-26T11:00:00.000Z',
        message: { role: 'user', content: 'earlier turn' },
      }),
      JSON.stringify({ type: 'bridge-session' }),
    ].join('\n')}\n`,
  );
  utimesSync(history, new Date(fileWrite), new Date(fileWrite));
  await writeLifecycle(s.name, { state: 'working', ts: turnStart, event: 'UserPromptSubmit' });

  // 20s after a fresh transcript write (70s past turnStart): turn stays live despite old message.
  const freshNow = fileWrite + 20_000;
  const liveObserved = observe(m, s, true, '❯\n? for shortcuts', freshNow);
  expect(liveObserved.turnOverMs).toBeNull();
  expect(readTurnState(m, s, claudeProvider, '❯\n? for shortcuts', freshNow)).toEqual({
    settled: false,
    why: 'quiet-unproven',
  });
  expect(projectMonitoringRow(m, s, 1, '❯\n? for shortcuts', liveObserved, freshNow)).toMatchObject(
    {
      state: 'working',
      lastActivityAt: '2026-11-26T11:00:00.000Z',
    },
  );

  // Past the 60s interrupted threshold: turn settles cleanly and dates turnOverMs to the last write.
  const quietNow = fileWrite + 61_000;
  const closedObserved = observe(m, s, true, '❯\n? for shortcuts', quietNow);
  expect(closedObserved.turnOverMs).toBe(fileWrite);
  expect(closedObserved.turnInterrupted).toBe(true);
  expect(readTurnState(m, s, claudeProvider, '❯\n? for shortcuts', quietNow)).toEqual({
    settled: true,
    why: 'idle-after-interrupt',
  });
});

test('codex lastActivityAt ignores trailing non-message event_msg timestamps and file mtime', () => {
  const base = fixture();
  const codexSessionsDir = join(base.stateDir, 'codex-sessions');
  const m = { ...base, codexSessionsDir };
  const s = makeSession({
    name: `codex-${crypto.randomUUID()}`,
    agent: 'codex',
    uuid: '66666666-6666-4666-8666-666666666666',
    dir: m.stateDir,
  });
  const rolloutDir = join(codexSessionsDir, '2026', '11', '21');
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = join(rolloutDir, `rollout-2026-11-21T03-00-00-${s.uuid}.jsonl`);
  const replyAt = '2026-11-21T03:26:03.966Z';
  writeFileSync(
    rollout,
    `${[
      JSON.stringify({
        type: 'response_item',
        timestamp: replyAt,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'codex reply' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-22T04:26:13.617Z',
        payload: { type: 'token_count' },
      }),
    ].join('\n')}\n`,
  );
  const laterMtime = new Date('2026-11-26T10:00:00.000Z');
  utimesSync(rollout, laterMtime, laterMtime);

  const row = projectMonitoringRow(m, s, 1, '› ', UNSEEN, Date.parse('2026-11-26T14:00:00.000Z'));
  expect(row.lastActivityAt).toBe(replyAt);
  expect(lastActivityMs(s, m)).toBe(Date.parse(replyAt));
  expect(transcriptMtimeMs(s, m)).toBe(laterMtime.getTime());
});

test('native sessions without a JSONL transcript derive lastActivityAt and step from live nativeItems', async () => {
  const m = fixture();
  const now = Date.now();
  const regGen = crypto.randomUUID();
  const s = makeSession({
    name: `native-${crypto.randomUUID()}`,
    agent: 'claude',
    uuid: '77777777-7777-4777-8777-777777777777',
    dir: m.stateDir,
    runtime: 'native',
    registrationGeneration: regGen,
    nativeSession: {
      runtime: 'claude',
      id: '77777777-7777-4777-8777-777777777777',
      version: '1.0.0',
    },
  });
  const toolAt = '2026-11-26T08:00:00.000Z';
  const usageAt = '2026-11-26T08:05:00.000Z';
  await new ManagedRuntimeStatusWriter(m, s).write({
    protocol: 1,
    provider: 'claude',
    machine: m.rcPrefix,
    session: s.name,
    threadId: s.uuid,
    generation: crypto.randomUUID(),
    sequence: 2,
    pid: process.pid,
    providerPid: process.pid,
    version: '1.0.0',
    connected: true,
    state: 'idle',
    reason: null,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
    turn: null,
    events: [],
    nativeSequence: 2,
    nativeItems: [
      {
        sequence: 1,
        at: toolAt,
        kind: 'tool',
        stage: 'completed',
        nativeId: 'call-1',
        turnId: 'turn-1',
        requestId: null,
        status: 'completed',
        text: 'echo hi',
        tool: 'Bash',
        usage: null,
      },
      {
        sequence: 2,
        at: usageAt,
        kind: 'usage',
        stage: 'updated',
        nativeId: 'turn-1:usage',
        turnId: 'turn-1',
        requestId: null,
        status: null,
        text: null,
        tool: null,
        usage: null,
      },
    ],
    pendingRequests: [],
    nativeSelection: null,
    registrationGeneration: regGen,
    nativeSession: s.nativeSession,
  });

  const row = projectMonitoringRow(m, s, undefined, null, UNSEEN, now);
  expect(row.running).toBe(true);
  expect(row.state).toBe('idle');
  expect(row.startedAt).toBeNull();
  expect(row.lastActivityAt).toBe(toolAt);
  expect(row.step).toEqual({ kind: 'tool_call', role: 'assistant', toolName: 'Bash', at: toolAt });
  expect(inventoryRow(row, undefined, null).step).toEqual(row.step ?? null);
});
