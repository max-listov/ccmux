import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  spawnFiniteWorkload,
  sweepFiniteWorkloadDirectories,
} from '../src/runtime/finiteWorkload.ts';
import {
  WORKLOAD_CANCEL_GRACE_MS,
  WORKLOAD_DIRECTORY_PREFIX,
} from '../src/runtime/workloadContract.ts';
import { finiteWorkloadSandbox } from '../src/runtime/workloadSandbox.ts';

// A launcher speaking protocol v1, steered by the request's label. It records what it saw so the
// test can check the request layout without trusting the adapter's own description of it.
const root = mkdtempSync(join(tmpdir(), 'ccmux-fake-launcher-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const launcherBin = join(root, 'node-workload-run');
const seen = join(root, 'seen.json');
writeFileSync(
  launcherBin,
  `#!${process.execPath}
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = Bun.argv.slice(2);
if (args[0] === '--describe') {
  console.log(JSON.stringify({ schema: 'node-workload-protocol/v1', command: 'node-workload-run',
    platform: 'linux', mode: 'disposable', supervisor: 'direct-parent-process-instance' }));
  process.exit(0);
}
const request = JSON.parse(readFileSync(args[1], 'utf8'));
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ request: args[1], scratch: request.scratchRoot,
  requestMode: statSync(args[1]).mode & 0o777, requestDir: dirname(args[1]) }));
const done = (result, code) => { writeFileSync(args[3], JSON.stringify({ schema: 'node-workload-result/v1', ...result })); process.exit(code); };
const completed = (exitCode, signal) => ({ status: 'completed', admissionId: crypto.randomUUID(), exitCode, signal, reason: null });
switch (request.label) {
  case 'complete': done(completed(0, null), 0);
  case 'refuse': done({ status: 'refused', reason: 'host-busy', detail: 'admission refused' }, 125);
  case 'mismatch': done(completed(0, null), 3);
  case 'payload-signalled': done(completed(null, 'SIGKILL'), 1);
  case 'payload-signalled-wrong-exit': done(completed(null, 'SIGKILL'), 137);
  case 'ignore-term': process.on('SIGTERM', () => {}); await Bun.sleep(60_000);
}
`,
);
chmodSync(launcherBin, 0o755);

const run = (label: string, bin = launcherBin) =>
  spawnFiniteWorkload(
    { launcherBin: bin, profileFile: '/etc/unused.json' },
    {
      label,
      executable: '/bin/true',
      args: [],
      cwd: root,
      environment: { CCMUX_CHAT_CREDENTIAL: 'secret' },
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      maxStdinBytes: 1,
    },
  );

test('the launcher outcome is believed only when its exit code agrees with protocol v1', async () => {
  expect(await run('complete').settled).toMatchObject({ status: 'completed', exitCode: 0 });
  expect(await run('refuse').settled).toMatchObject({ status: 'refused', reason: 'host-busy' });
  expect(await run('mismatch').settled).toMatchObject({
    status: 'failed',
    reason: 'workload-outcome-unavailable',
    detail: 'workload-result-exit-mismatch',
  });
  // A payload ended by a signal has no exit code; the launcher reports that as 1, not as 128+n.
  expect(await run('payload-signalled').settled).toMatchObject({
    status: 'completed',
    signal: 'SIGKILL',
  });
  expect(await run('payload-signalled-wrong-exit').settled).toMatchObject({ status: 'failed' });
});

test('the payload scratch is apart from the private request, and both are removed after', async () => {
  await run('complete').settled;
  const { request, scratch, requestMode, requestDir } = JSON.parse(
    await Bun.file(seen).text(),
  ) as Record<string, string | number>;
  expect(requestMode).toBe(0o600);
  expect(scratch).toBe(join(String(requestDir), 'scratch'));
  expect(existsSync(String(request))).toBe(false);
  expect(existsSync(String(requestDir))).toBe(false);
});

test(
  'a launcher that ignores cancellation is killed after the grace, and says so',
  async () => {
    const child = run('ignore-term');
    await Bun.sleep(200);
    const started = performance.now();
    child.kill('SIGKILL');
    const outcome = await child.settled;
    const elapsed = performance.now() - started;
    expect(outcome).toMatchObject({ status: 'failed', reason: 'workload-cancel-timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(WORKLOAD_CANCEL_GRACE_MS - 50);
    expect(elapsed).toBeLessThan(WORKLOAD_CANCEL_GRACE_MS + 3_000);
  },
  WORKLOAD_CANCEL_GRACE_MS + 10_000,
);

test('a missing launcher is a failed outcome, not a hang or a throw', async () => {
  expect(await run('complete', join(root, 'absent')).settled).toMatchObject({
    status: 'failed',
    reason: 'workload-outcome-unavailable',
  });
});

test.skipIf(process.platform !== 'linux')(
  'probe answers unavailable for a missing or non-describing launcher, partial for a real one',
  async () => {
    const probe = (bin: string) =>
      finiteWorkloadSandbox({ launcherBin: bin, profileFile: '/etc/unused.json' }).probe();
    expect(await probe(launcherBin)).toMatchObject({ grade: 'partial' });
    expect(await probe(join(root, 'absent'))).toMatchObject({ grade: 'unavailable' });
    expect(await probe('/bin/true')).toMatchObject({ grade: 'unavailable' });
  },
);

test('abandoned request directories of this user are swept once past every deadline', () => {
  const old = mkdtempSync(join(tmpdir(), WORKLOAD_DIRECTORY_PREFIX));
  const fresh = mkdtempSync(join(tmpdir(), WORKLOAD_DIRECTORY_PREFIX));
  const other = join(tmpdir(), `ccmux-other-${crypto.randomUUID()}`);
  mkdirSync(other);
  try {
    writeFileSync(join(old, 'request.json'), '{}', { mode: 0o600 });
    const past = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(sweepFiniteWorkloadDirectories(10 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    expect(existsSync(old)).toBe(false);
    expect(statSync(fresh).isDirectory()).toBe(true);
    expect(existsSync(other)).toBe(true);
  } finally {
    for (const path of [old, fresh, other]) rmSync(path, { recursive: true, force: true });
  }
});
