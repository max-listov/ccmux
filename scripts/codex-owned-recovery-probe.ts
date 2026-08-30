#!/usr/bin/env bun
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readCodexAppThread, startCodexAppTurn } from '../src/agent/codex/appServer.ts';
import { ownedCodexSocket, ownedCodexStatusPath } from '../src/agent/codex/ownedPaths.ts';
import { readCodexRuntime } from '../src/agent/codex/ownedRead.ts';
import { connectOwnedCodex } from '../src/agent/codex/ownedRpc.ts';
import { readOwnedCodexStatus } from '../src/agent/codex/ownedStatus.ts';
import { inspectNativeCodexInput } from '../src/agent/codex/pane.ts';
import { codexTextInput } from '../src/agent/codex/turnInput.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { readEvents } from '../src/events/feed.ts';
import {
  capturePaneStyled,
  killSession,
  newSession,
  sendKeysLiteral,
  sendKeysNamed,
} from '../src/tmux/tmux.ts';

const config = process.argv[2];
if (config === undefined || !basename(dirname(config)).startsWith('ccmux-owned-probe-'))
  throw new Error('Pass an isolated runtime probe config');
const root = dirname(config),
  cli = process.argv[3] ?? join(process.cwd(), 'src/cli.ts');
const m = MachineConfigSchema.parse(JSON.parse(readFileSync(config, 'utf8')));
if (
  m.stateDir !== join(root, 'state') ||
  m.telegram !== undefined ||
  Object.keys(m.fleet ?? {}).length ||
  !m.sessionEvents
)
  throw new Error('Probe must be isolated with events enabled');
const s = loadSessions(m).find((row) => row.name === 'agent-a');
if (s === undefined) throw new Error('Missing probe session');
const env: Record<string, string> = {
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: m.stateDir,
  CCMUX_CACHE_DIR: join(root, 'cache'),
};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && env[key] === undefined) env[key] = value;
for (const key of [
  'CCMUX_SESSION',
  'CCMUX_CHAT_CREDENTIAL',
  'CODEX_THREAD_ID',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
])
  delete env[key];
const snapshot = () => readOwnedCodexStatus(m, s).snapshot;
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function progress(phase: string, evidence: unknown) {
  console.log(JSON.stringify({ phase, evidence }));
}
async function until(label: string, condition: () => boolean, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    check(Date.now() < deadline, `Timed out: ${label}`);
    await Bun.sleep(50);
  }
}

const baseline = snapshot();
check(baseline?.state === 'idle', 'Known positive live idle required');
let rpc = await connectOwnedCodex(m, s);
check((await readCodexAppThread(rpc, s.uuid)).status.type === 'idle', 'Native baseline not idle');
check(
  inspectNativeCodexInput(await capturePaneStyled(m, s.name, 40)).state === 'deliverable',
  'Interactive composer not ready',
);
const feedStart = new Date().toISOString();
// Actual native CLI input and independent RPC observation share the same provider process.
check(
  await sendKeysLiteral(m, s.name, 'Reply SAME_WRITER_TEST briefly, without tools or messages.'),
  'Interactive typing failed',
);
// Codex treats immediate text+Enter as one paste burst, not a user submission.
await Bun.sleep(250);
check(await sendKeysNamed(m, s.name, 'Enter'), 'Interactive submit failed');
await until(
  'interactive client started a native turn',
  () => snapshot()?.turn?.id !== baseline.turn?.id && snapshot()?.state === 'working',
);
const interactiveTurn = snapshot()?.turn?.id;
check(
  (await readCodexAppThread(rpc, s.uuid)).status.type === 'active',
  'Interactive turn missing in native RPC',
);
await until(
  'interactive completion',
  () => snapshot()?.turn?.id === interactiveTurn && snapshot()?.state === 'idle',
);
check(
  snapshot()?.providerPid === baseline.providerPid,
  'Interactive client launched another writer',
);
const feed = readEvents(m, { session: s.name, since: feedStart });
check(
  feed.some((event) => event.event === 'turn-start') &&
    feed.some((event) => event.event === 'turn-end'),
  'Native boundaries missing from existing event feed',
);
progress('same-writer-and-native-feed', {
  threadId: s.uuid,
  providerPid: baseline.providerPid,
  interactiveTurn,
  events: feed.map(({ event, threadId }) => ({ event, threadId })),
});

const active = await startCodexAppTurn(
  rpc,
  s.uuid,
  crypto.randomUUID(),
  codexTextInput(
    'Run sleep 8, then reply DAEMON_CONTINUITY. Do not change files or message anyone.',
  ),
);
await until(
  'active before daemon restart',
  () => snapshot()?.turn?.id === active && snapshot()?.state === 'working',
);
await killSession(m, 'probe-daemon');
await newSession(m, 'probe-daemon', root, [process.execPath, '--no-env-file', cli, 'daemon'], env);
check(
  snapshot()?.providerPid === baseline.providerPid && snapshot()?.turn?.id === active,
  'Daemon restart replaced provider or turn',
);
await until(
  'turn survived daemon restart',
  () => snapshot()?.turn?.id === active && snapshot()?.state === 'idle',
);
progress('daemon-restart-continuity', { providerPid: baseline.providerPid, turnId: active });

// Crash ONLY the exact provider already identified by this isolated instance's live RPC.
const args = Bun.spawnSync(['ps', '-p', String(baseline.providerPid), '-o', 'args='], {
  stdout: 'pipe',
  stderr: 'pipe',
});
check(
  args.exitCode === 0 &&
    args.stdout.toString().includes(`app-server --listen unix://${ownedCodexSocket(m, s.name)}`),
  'Crash target does not match isolated provider',
);
rpc.close();
const killedAt = performance.now();
process.kill(baseline.providerPid, 'SIGKILL');
await until('dead producer expires', () => readOwnedCodexStatus(m, s).status !== 'live', 5_000);
const expiredMs = performance.now() - killedAt;
await until('supervisor resumes pinned UUID', () => {
  const next = snapshot();
  return (
    next !== null &&
    next.providerPid !== baseline.providerPid &&
    next.generation !== baseline.generation &&
    next.state === 'idle'
  );
});
check(
  loadSessions(m).find((row) => row.name === s.name)?.uuid === s.uuid,
  'Crash recovery changed UUID',
);
rpc = await connectOwnedCodex(m, s);
check((await readCodexAppThread(rpc, s.uuid)).id === s.uuid, 'Recovered native identity mismatch');
rpc.close();
progress('provider-crash-resume', {
  threadId: s.uuid,
  beforePid: baseline.providerPid,
  afterPid: snapshot()?.providerPid,
  expiredMs,
});

process.env.CCMUX_CONFIG = config;
process.env.CCMUX_STATE_DIR = m.stateDir;
const benchPid = snapshot()?.providerPid;
let completedAt: number | null = null,
  deliveredAfterMs: number | null = null,
  loadTurn: string | null = null;
let sawWorking = false,
  sawCompletion = false;
rpc = await connectOwnedCodex(m, s, {
  onEvent(event) {
    if (event.method !== 'turn/completed') return;
    const value = event.params as { threadId?: unknown; turn?: { id?: unknown } };
    if (value.threadId === s.uuid && value.turn?.id === loadTurn) completedAt = Date.now();
  },
});
// Native notifications are connection-scoped: rejoin the already-owned thread before measuring
// event delivery. Starting a turn from an unjoined RPC client alone is not a subscription.
await rpc.request('thread/resume', { threadId: s.uuid, excludeTurns: true });
const started = performance.now(),
  cpu = process.cpuUsage(),
  initialRss = process.memoryUsage().rss;
let calls = 0,
  peakRss = initialRss,
  maxBytes = 0;
try {
  while (performance.now() - started < 60_000) {
    if (loadTurn === null && performance.now() - started >= 1000)
      loadTurn = await startCodexAppTurn(
        rpc,
        s.uuid,
        crypto.randomUUID(),
        codexTextInput('Reply READER_LOAD_TEST briefly. No tools, files or messages.'),
      );
    const batch = await Promise.all(
      Array.from({ length: 100 }, () =>
        readCodexRuntime({ session: s.name, threadId: s.uuid, timeoutMs: 1000 }),
      ),
    );
    check(
      batch.every((read) => read.status === 'live' && read.snapshot?.providerPid === benchPid),
      'Resident load lost/replaced the native runtime',
    );
    const observed = batch[0]?.snapshot;
    if (loadTurn !== null && observed?.turn?.id === loadTurn) {
      if (observed.state === 'working') sawWorking = true;
      if (observed.turn.status === 'completed') {
        sawCompletion = true;
        if (deliveredAfterMs === null && completedAt !== null)
          deliveredAfterMs = Date.now() - completedAt;
      }
    }
    calls += batch.length;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    maxBytes = Math.max(maxBytes, statSync(ownedCodexStatusPath(m, s.name)).size);
    await Bun.sleep(100);
  }
} finally {
  rpc.close();
}
check(
  sawWorking && sawCompletion && deliveredAfterMs !== null,
  `Native turn boundaries were not delivered under reader load: ${JSON.stringify({ sawWorking, sawCompletion, completedAt, deliveredAfterMs })}`,
);
progress('resident-load', {
  elapsedMs: performance.now() - started,
  calls,
  cpu: process.cpuUsage(cpu),
  initialRss,
  peakRss,
  finalRss: process.memoryUsage().rss,
  maxBytes,
  providerPid: benchPid,
  deliveredAfterMs,
});
progress('completed-recovery-e2e', { threadId: s.uuid });
