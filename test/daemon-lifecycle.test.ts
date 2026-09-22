import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, lifecycleLedgerResource } from 'stitchkit/application';
import { privateRuntimeDirectory } from '../src/agent/codex/ownedPaths.ts';
import { createDaemonLifecycle, recordForcedStop } from '../src/daemon/lifecycle.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'ccmux-lifecycle-'));
  roots.push(stateDir);
  privateRuntimeDirectory(join(stateDir, 'native-diagnostics'));
  return {
    stateDir,
    path: join(stateDir, 'native-diagnostics', 'daemon-lifecycle.json'),
    ledger: createDaemonLifecycle({ stateDir }),
  };
}

test('a corrupt lifecycle store fails closed without replacing the evidence', async () => {
  const { ledger, path } = await fixture();
  await writeFile(path, '{broken state');
  await expect(ledger.recordStart({ version: 'test-build' })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken state');
});

test('the lifecycle resource persists forced shutdown and a new run after restart', async () => {
  const { ledger } = await fixture();
  const resource = lifecycleLedgerResource(ledger, { version: 'test-build' });
  const application = createApplication({
    id: 'isolated-lifecycle',
    resources: [resource],
  });
  await application.start();
  const first = await ledger.current();
  expect(first?.readyAt).toBeString();
  const abort = new AbortController();
  abort.abort();
  const result = await application.shutdown({ signal: abort.signal });
  expect(result.outcome).toBe('forced');
  expect((await ledger.current())?.termination).toBe('forced');
  const restarted = createApplication({ id: 'restarted-lifecycle', resources: [resource] });
  await restarted.start();
  const second = await ledger.current();
  expect(second?.runId).not.toBe(first?.runId);
  expect(second?.readyAt).toBeString();
  await restarted.shutdown();
  expect((await ledger.current())?.termination).toBe('clean');
});

test('a forced stop the drain could not write is stamped afterwards, so the next start measures it', async () => {
  // The force phase runs on what is left of a seven-second budget, and under memory pressure the
  // ledger write is what does not finish. The run then ends with no stop of its own, and the next
  // start reports an abnormal exit and an unmeasured downtime for a daemon that was ASKED to stop.
  const { stateDir } = await fixture();
  const dying = createDaemonLifecycle({ stateDir });
  await dying.recordStart({ version: 'test-build' });
  await dying.recordReady();
  await recordForcedStop(dying);
  const stopped = (await dying.runs())[0];
  expect(stopped?.termination).toBe('forced');
  expect(stopped?.stoppedAt).not.toBeNull();

  // Idempotent: a stop that DID land during the drain is left exactly as it was.
  await recordForcedStop(dying);
  expect((await dying.runs())[0]?.stoppedAt).toBe(stopped?.stoppedAt ?? null);

  // What the operator reads next: a forced stop, and a downtime that is a measurement.
  const next = await createDaemonLifecycle({ stateDir }).recordStart({ version: 'test-build' });
  expect(next.previousExit).toBe('forced');
  expect(next.downtimeMs).not.toBeNull();
  // The invariant this must not weaken — a run that never reached its own stop is still called
  // abnormal — is pinned on real processes by `test/monitoring-daemon.test.ts`, which SIGKILLs a
  // spawned daemon and asserts the next start says so. It cannot be staged in-process: two ledgers
  // here share one pid, and a shared pid is a hot reload by definition.
});
