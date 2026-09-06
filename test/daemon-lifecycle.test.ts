import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, lifecycleLedgerResource } from 'stitchkit/application';
import { privateRuntimeDirectory } from '../src/agent/codex/ownedPaths.ts';
import { createDaemonLifecycle } from '../src/daemon/lifecycle.ts';

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
