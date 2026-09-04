#!/usr/bin/env bun
// Opt-in provider-usage test. Only the two threads created here may be interrupted or archived.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { connectCodexAppServer } from '../src/agent/codex/appServer.ts';
import { loadMachineConfig } from '../src/config/machine.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlServer } from '../src/control/server.ts';
import { ExternalStatusObserver } from '../src/external/resident-observer.ts';
import { ExternalStatusPublisher } from '../src/external/resident-publisher.ts';
import { currentExternalStatus } from '../src/external/resident-schema.ts';
import { VERSION } from '../src/util/version.ts';

if (!Bun.argv.includes('--run')) {
  console.error(
    'usage: bun scripts/external-resident-e2e.ts --run [--source] (creates two read-only test threads)',
  );
  process.exit(2);
}
const source = Bun.argv.includes('--source'),
  machine = loadMachineConfig();
const root = mkdtempSync('/tmp/ccmux-resident-e2e-'),
  ipc = { ...machine, stateDir: root };
const external = new ExternalStatusPublisher(machine.rcPrefix),
  observer = new ExternalStatusObserver(machine, external);
const managed = new ControlPublisher(ipc);
const owned = source
  ? createControlServer(ipc, managed, undefined, () => ipc, external)
  : undefined;
const client = createControlClient(source ? { socket: controlSocket(ipc) } : {});
const rpc = await connectCodexAppServer(machine);
const threads: string[] = [],
  turns = new Map<string, string>();
const abort = new AbortController();
let timer: ReturnType<typeof setInterval> | undefined, streamTask: Promise<void> | undefined;
let cleanupFailed = false;
const observed = new Map<string, Set<string>>();
const Thread = z.object({ thread: z.object({ id: z.uuid() }) });
const Turn = z.object({ turn: z.object({ id: z.string().min(1) }) });
let frames = 0;

async function matches(states: string[]): Promise<void> {
  const until = Date.now() + 55_000;
  while (Date.now() < until) {
    const snapshot = currentExternalStatus(await client['external.list']());
    if (
      threads.every(
        (id, n) =>
          snapshot.sessions.find((s) => s.identity.threadId === id)?.turnState.state === states[n],
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error(`Resident states not observed: ${states.join(',')}`);
}

try {
  if (source) {
    await observer.refresh();
    timer = setInterval(() => void observer.refresh(), 2000);
  }
  const first = await client['external.list']();
  if (first.status !== 'live' || first.version !== VERSION)
    throw new Error('live installed/candidate version does not match checkout');
  const stream = await client.watchExternal.withOptions({ signal: abort.signal });
  streamTask = (async () => {
    try {
      for await (const snapshot of stream) {
        frames++;
        for (const row of currentExternalStatus(snapshot).sessions) {
          if (!threads.includes(row.identity.threadId)) continue;
          const states = observed.get(row.identity.threadId) ?? new Set<string>();
          states.add(row.turnState.state);
          observed.set(row.identity.threadId, states);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  for (let n = 0; n < 2; n++) {
    const response = Thread.parse(
      await rpc.request('thread/start', {
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: 'You are a lifecycle test agent. Do not modify files or use the network.',
        developerInstructions: 'Only follow the test prompt; return a short final answer.',
      }),
    );
    threads.push(response.thread.id);
  }
  writeFileSync(join(root, 'test-threads.json'), JSON.stringify(threads));
  console.log(JSON.stringify({ phase: 'created', threads: threads.length }));
  for (const [index, id] of threads.entries()) {
    const text =
      index === 0
        ? 'Run the shell command sleep 20 exactly once, wait, then reply DONE. Do not modify files.'
        : 'Reply exactly DONE without using tools.';
    const result = Turn.parse(
      await rpc.request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text, text_elements: [] }],
      }),
    );
    turns.set(id, result.turn.id);
  }
  console.log(JSON.stringify({ phase: 'started' }));
  // New empty threads need not have a database row until their first turn is persisted.
  // The first positive resident identity/state check is the real working/completed pair.
  await matches(['working', 'idle']);
  console.log(JSON.stringify({ phase: 'working-idle' }));
  const firstId = threads[0];
  if (!firstId) throw new Error('test identity missing');
  await rpc.request('turn/interrupt', { threadId: firstId, turnId: turns.get(firstId) });
  await matches(['idle', 'idle']);
  // A separate consumer must see the same current identities without another provider writer.
  const reconnect = createControlClient(source ? { socket: controlSocket(ipc) } : {});
  try {
    const snapshot = await reconnect['external.list']();
    if (
      !threads.every((id) =>
        snapshot.sessions.some((s) => s.identity.threadId === id && s.turnState.state === 'idle'),
      )
    )
      throw new Error('reconnect lost native idle identity');
  } finally {
    await reconnect.close();
  }
  if (!threads.every((id) => observed.get(id)?.has('working') && observed.get(id)?.has('idle')))
    throw new Error('stream missed test transitions');
  if (source && observer.metrics().notifications === 0)
    throw new Error('native notifications were not delivered');
  console.log(
    JSON.stringify({
      success: true,
      version: VERSION,
      mode: source ? 'source' : 'installed',
      frames,
      states: threads.map((id, index) => ({
        thread: index === 0 ? 'test-A' : 'test-B',
        states: [...(observed.get(id) ?? [])],
      })),
      ...(source ? { observer: observer.metrics() } : {}),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      phase: 'failed',
      error: String(error),
      observer: observer.metrics(),
      observed: threads.map((id) => [...(observed.get(id) ?? [])]),
      testDirectory: root,
    }),
  );
  throw error;
} finally {
  if (timer) clearInterval(timer);
  abort.abort();
  await streamTask;
  for (const threadId of threads) {
    const turnId = turns.get(threadId);
    if (turnId) await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    await rpc.request('thread/archive', { threadId }).catch((error) => {
      cleanupFailed = true;
      console.error(
        JSON.stringify({
          phase: 'archive-failed',
          threadId,
          error: String(error),
          testDirectory: root,
        }),
      );
    });
  }
  rpc.close();
  await client.close();
  await observer.close();
  managed.close();
  if (owned) {
    await owned.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await owned.observability.close();
  }
  if (!cleanupFailed) rmSync(root, { recursive: true, force: true });
}
if (cleanupFailed)
  throw new Error('test thread archive failed; retain test directory for inspection');
