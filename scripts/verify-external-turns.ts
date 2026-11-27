#!/usr/bin/env bun
// Opt-in live acceptance test. Creates only its own two read-only provider test threads.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMachineConfig } from '../src/config/machine.ts';
import { ExternalInventoryJsonSchema } from '../src/external/sessionSchema.ts';
import { VERSION } from '../src/util/version.ts';
import { externalProbeThreads } from './externalProbeServer.ts';

if (Bun.argv[2] !== '--run') {
  console.error(
    'usage: bun scripts/verify-external-turns.ts --run (creates and archives two test threads; uses installed stitchmux)',
  );
  process.exit(2);
}

const ids: string[] = [];
let cleanupFailed = false;
const turns = new Map<string, string>();
const root = mkdtempSync(join(tmpdir(), 'stitchmux-turn-e2e-'));
const probes = externalProbeThreads(loadMachineConfig(), root);

async function start(threadId: string, text: string): Promise<void> {
  const { turnId } = await probes.get(threadId).startThreadTurn({
    threadId,
    clientId: crypto.randomUUID(),
    input: [{ type: 'text', text }],
  });
  turns.set(threadId, turnId);
}

async function snapshot(label: string) {
  const child = Bun.spawn(['stitchmux', 'external', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if ((await child.exited) !== 0) throw new Error(`inventory command failed: ${err}`);
    const inventory = ExternalInventoryJsonSchema.parse(JSON.parse(out));
    if (inventory.version !== VERSION)
      throw new Error('installed CLI version does not match checkout');
    const rows = inventory.sessions.filter((s) => ids.includes(s.threadId));
    if (rows.length !== 2) throw new Error('inventory must contain both exact test identities');
    console.log(
      JSON.stringify({
        label,
        version: inventory.version,
        rows: rows.map((s) => ({
          thread: s.threadId === ids[0] ? 'test-A' : 'test-B',
          writer: s.writerEvidence,
          runtime: s.writerRuntime?.kind,
          turn: s.turnState,
        })),
      }),
    );
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

function sharedWriter(rows: Awaited<ReturnType<typeof snapshot>>): boolean {
  const pid = rows[0]?.writerRuntime?.pid;
  return (
    typeof pid === 'number' &&
    rows.every(
      (s) =>
        s.writerEvidence === 'observed' &&
        s.writerRuntime?.kind === 'shared' &&
        s.writerRuntime.pid === pid,
    )
  );
}

try {
  for (let i = 0; i < 2; i++) {
    const session = await probes.open();
    ids.push(session.nativeThreadId);
    if (session.threadContext.thread?.status?.type !== 'idle')
      throw new Error('new test thread was not idle');
  }
  const a = ids[0];
  const b = ids[1];
  if (!a || !b) throw new Error('missing test identity');
  await start(b, 'Reply with exactly DONE. Do not use tools.');
  await start(
    a,
    'Run the shell command sleep 25 exactly once, wait for it, then reply DONE. Do not modify files.',
  );
  // Validate the exact-identity lookup on a positive case before entering any wait loop.
  await snapshot('initial');
  let split = false;
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const rows = await snapshot('observe');
    if (
      rows.some((s) => s.threadId === a && s.turnState.state === 'working') &&
      rows.some((s) => s.threadId === b && s.turnState.state === 'idle')
    ) {
      if (!sharedWriter(rows)) throw new Error('independent states lost shared writer evidence');
      split = true;
      break;
    }
    await Bun.sleep(1000);
  }
  if (!split) throw new Error('independent active/completed states not observed');
  const firstTurnId = turns.get(a);
  if (!firstTurnId) throw new Error('test turn missing');
  await probes.get(a).interruptTurn({ threadId: a, turnId: firstTurnId });
  let idle = false;
  for (let i = 0; i < 15; i++) {
    const rows = await snapshot('interrupted');
    if (rows.every((s) => s.turnState.state === 'idle') && sharedWriter(rows)) {
      idle = true;
      break;
    }
    await Bun.sleep(500);
  }
  if (!idle) throw new Error('interrupted turn did not settle to idle with its writer retained');
  // Every installed-CLI invocation opens a fresh native connection: this is also reconnect proof.
  const rows = await snapshot('reconnected');
  if (!rows.every((s) => s.turnState.state === 'idle') || !sharedWriter(rows))
    throw new Error('reconnect proof failed');
} finally {
  for (const threadId of ids) {
    const turnId = turns.get(threadId);
    if (turnId)
      await probes
        .get(threadId)
        .interruptTurn({ threadId, turnId })
        .catch(() => {});
    await probes
      .get(threadId)
      .archiveThread({ threadId })
      .catch(() => {
        cleanupFailed = true;
      });
  }
  await probes.close();
}
if (cleanupFailed)
  throw new Error('test thread archive failed; inspect provider test threads before rerunning');
console.log(JSON.stringify({ success: true, version: VERSION }));
