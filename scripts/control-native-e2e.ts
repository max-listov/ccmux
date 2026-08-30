#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { connectOwnedCodex } from '../src/agent/codex/ownedRpc.ts';
import { readOwnedCodexStatus } from '../src/agent/codex/ownedStatus.ts';
import { managedPeer, samePrincipal, sameTarget } from '../src/chat/identity.ts';
import { findOwnedCodexReceipt } from '../src/chat/ownedCodexReceipt.ts';
import { loadLedger } from '../src/chat/store.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { readMonitoringStatus } from '../src/monitoring/read.ts';
import { killSession, newSession } from '../src/tmux/tmux.ts';
import { shellJoin } from '../src/util/shellQuote.ts';

const config = process.argv[2];
if (!config || !basename(dirname(config)).startsWith('ccmux-owned-probe-'))
  throw new Error('Pass an isolated owned-runtime probe config');
const root = dirname(config),
  cli = process.argv[3] ?? join(process.cwd(), 'src/cli.ts');
const m = MachineConfigSchema.parse(JSON.parse(readFileSync(config, 'utf8')));
if (
  m.stateDir !== join(root, 'state') ||
  m.telegram ||
  Object.keys(m.fleet ?? {}).length ||
  !m.tmuxSocket?.startsWith('ccmux-owned-')
)
  throw new Error('Probe is not isolated');
const sessions = loadSessions(m);
const a = sessions.find((s) => s.name === 'agent-a'),
  b = sessions.find((s) => s.name === 'agent-b');
if (!a || !b || a.runtime !== 'app-server' || b.runtime !== 'app-server')
  throw new Error('Run the two-session native launcher first');
const targetA = managedPeer(m.rcPrefix, a),
  targetB = managedPeer(m.rcPrefix, b);
const env: Record<string, string> = {
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: m.stateDir,
  CCMUX_DATA_DIR: join(root, 'data'),
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
const client = createControlClient({ socket: controlSocket(m) });
const abort = new AbortController();
const seen = new Set<string>();
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function progress(phase: string, evidence: unknown) {
  console.log(JSON.stringify({ phase, evidence }));
}
async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeout = 120_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    check(Date.now() < deadline, `Timeout: ${label}`);
    await Bun.sleep(200);
  }
}
async function settled(target: typeof targetA) {
  let result = await client.wait({ target, timeoutMs: 60_000 });
  if (result.outcome === 'timeout') result = await client.wait({ target, timeoutMs: 60_000 });
  check(
    ['completed', 'interrupted', 'idle'].includes(result.outcome),
    `Not settled: ${JSON.stringify(result)}`,
  );
  return result;
}
const invocation = shellJoin([process.execPath, '--no-env-file', cli]);
async function roundTrip(label: string) {
  const token = `control-${crypto.randomUUID()}`;
  const request = `Authorized isolated communication test ${token}. Invoke exactly ${invocation} msg ${targetB.machine}:${targetB.session} --to-agent codex --to-thread ${targetB.threadId} with this body: '${token} A_TO_B. Reply once with ${token} B_TO_A using the pinned reply command supplied by ccmux. Do not message anyone else.' Do not reuse CLI paths from earlier history. When B_TO_A arrives finish with RECEIVED, without sending another message. Do not change files or do unrelated work.`;
  const messageId = crypto.randomUUID();
  check(
    (await client.message({ target: targetA, messageId, body: request })).accepted,
    'Not accepted',
  );
  check(
    (await client.message({ target: targetA, messageId, body: request })).duplicate,
    'Duplicate was not recognized',
  );
  await until(label, () => {
    const messages = loadLedger(m).filter((item) => item?.body.includes(token));
    return (
      messages.some(
        (item) => item && samePrincipal(item.from, targetA) && sameTarget(item.to, targetB),
      ) &&
      messages.some(
        (item) => item && samePrincipal(item.from, targetB) && sameTarget(item.to, targetA),
      )
    );
  });
  await Promise.all([settled(targetA), settled(targetB)]);
  progress(
    label,
    loadLedger(m)
      .filter((item) => item?.body.includes(token))
      .map((item) => item && { id: item.id, from: item.from, to: item.to }),
  );
}

try {
  const baseline = await client.list();
  check(
    baseline.status === 'live' &&
      baseline.sessions.some((s) => s.identity.threadId === a.uuid) &&
      baseline.sessions.some((s) => s.identity.threadId === b.uuid),
    'Known positive two-session baseline missing',
  );
  await Promise.all([settled(targetA), settled(targetB)]);
  const stream = await client.watch.withOptions({ signal: abort.signal });
  const observer = (async () => {
    try {
      for await (const snapshot of stream)
        for (const row of snapshot.sessions)
          seen.add(`${row.identity.session}:${row.state}:${row.availability}`);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  try {
    await roundTrip('control-A-B-A');
    await client.message({
      target: targetA,
      messageId: crypto.randomUUID(),
      body: 'Run sleep 15, then reply BUSY_DONE only. This is an isolated delivery test; do not change files or contact anyone.',
    });
    let busy = await client.get({ target: targetA });
    await until('busy turn before deferred control message', async () => {
      busy = await client.get({ target: targetA });
      return busy.state === 'working' && busy.turn?.status === 'inProgress';
    });
    check(busy.turn, 'No busy turn identity');
    const deferredId = crypto.randomUUID();
    await client.message({
      target: targetA,
      messageId: deferredId,
      body: 'Reply CONTROL_DEFERRED_DONE only.',
      defer: true,
    });
    check(
      (await client.wait({ target: targetA, timeoutMs: 1000 })).outcome === 'timeout',
      'Busy wait settled before deferred delivery',
    );
    check(
      readOwnedCodexStatus(m, a).snapshot?.turn?.id === busy.turn.id,
      'Deferred control message replaced the busy turn',
    );
    await settled(targetA);
    const deferredRpc = await connectOwnedCodex(m, a);
    try {
      check(
        (await findOwnedCodexReceipt(deferredRpc, a.uuid, deferredId))?.status === 'completed',
        'Deferred control message has no completed native receipt',
      );
    } finally {
      deferredRpc.close();
    }
    progress('control-busy-defer-wait', { busyTurn: busy.turn.id, deferredId });

    const busyMessage = crypto.randomUUID();
    await client.message({
      target: targetA,
      messageId: busyMessage,
      body: 'Run sleep 30, then reply TIMING_DONE only. This is an isolated interruption test; do not change files or contact anyone.',
    });
    let active = await client.get({ target: targetA });
    await until('working turn via control stream', async () => {
      active = await client.get({ target: targetA });
      return active.state === 'working' && active.turn?.status === 'inProgress';
    });
    check(active.turn, 'No native turn identity');
    const interruptedTurn = active.turn.id;
    await client.interrupt({
      target: targetA,
      generation: (await client.native({ target: targetA })).generation,
      turnId: interruptedTurn,
    });
    check(
      (await settled(targetA)).outcome === 'interrupted',
      'Interruption reported as normal completion',
    );
    const recoveryId = crypto.randomUUID();
    await client.message({
      target: targetA,
      messageId: recoveryId,
      body: 'Reply CONTROL_INTERRUPTION_RECOVERED only.',
    });
    await settled(targetA);
    const rpc = await connectOwnedCodex(m, a);
    try {
      check(
        (await findOwnedCodexReceipt(rpc, a.uuid, recoveryId))?.status === 'completed',
        'Recovery has no completed native receipt',
      );
    } finally {
      rpc.close();
    }
    progress('control-interrupt-and-pickup', { interruptedTurn, recoveryId });

    const before = [a, b].map((s) => readOwnedCodexStatus(m, s).snapshot);
    check(
      before.every((snapshot) => snapshot !== null),
      'Missing provider baseline before daemon restart',
    );
    const daemonPid = readMonitoringStatus(m).snapshot?.pid;
    check(daemonPid && daemonPid !== process.pid, 'No exact isolated daemon PID');
    process.kill(daemonPid, 'SIGTERM');
    await until(
      'old daemon exited',
      () => {
        try {
          process.kill(daemonPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      10_000,
    );
    await observer;
    const after = [a, b].map((s) => readOwnedCodexStatus(m, s).snapshot);
    check(
      after.every(
        (s, i) =>
          s && s.providerPid === before[i]?.providerPid && s.threadId === before[i]?.threadId,
      ),
      'Daemon shutdown changed a provider identity or PID',
    );
    await killSession(m, 'probe-daemon');
    await newSession(
      m,
      'probe-daemon',
      root,
      [process.execPath, '--no-env-file', cli, 'daemon'],
      env,
    );
    await until(
      'fresh control generation',
      async () => {
        try {
          const fresh = await client.list();
          return fresh.status === 'live' && fresh.generation !== baseline.generation;
        } catch {
          return false;
        }
      },
      10_000,
    );
    const replacement = await client.watch();
    check(
      (await replacement.next()).value?.generation !== baseline.generation,
      'Reconnect reused stale baseline',
    );
    await replacement.return?.();
    progress('daemon-restart-preserves-writers', {
      before: before.map((s) => s && { threadId: s.threadId, providerPid: s.providerPid }),
      after: after.map((s) => s && { threadId: s.threadId, providerPid: s.providerPid }),
    });
    await client.start({ target: targetA }); // existing runtime: idempotent, no second writer
    check(
      readOwnedCodexStatus(m, a).snapshot?.providerPid === after[0]?.providerPid,
      'Start duplicated a running provider',
    );
    await roundTrip('control-A-B-A-after-daemon-restart');
    check(
      seen.has('agent-a:working:live') && seen.has('agent-a:idle:live'),
      'Live stream missed the state transition',
    );
    progress('control-native-complete', { identities: [targetA, targetB], observed: [...seen] });
  } finally {
    abort.abort();
    await client.close();
    await observer;
  }
} finally {
  await client.close();
}
