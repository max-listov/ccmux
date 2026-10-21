import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedCodexProjection } from '../src/agent/codex/owned/projection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/owned/status.ts';
import { stableJson } from '../src/agent/launch/launchInputs.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import { cliPrincipal, managedPeer } from '../src/chat/identity.ts';
import { appendMessageOnce } from '../src/chat/ledger.ts';
import { controlContract } from '../src/control/schema/contract.ts';
import { cancelDelegation, delegationStopped } from '../src/delegation/cancel.ts';
import { type DelegatedPolicy, DelegationSchema } from '../src/delegation/schema.ts';
import { withNativeAdmission } from '../src/runtime/admission.ts';
import { seedNativeSelection } from '../src/runtime/selection.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import {
  processesReleased,
  sleepSession,
  wakeSession,
  wakeSleepingSession,
} from '../src/session/sleep/operations.ts';
import { idleProof } from '../src/session/sleep/proof.ts';
import { SleepReceiptSchema } from '../src/session/sleep/schema.ts';
import { readSleep, sleepBlocksStart, writeSleep } from '../src/session/sleep/store.ts';
import { writeWakeOperations } from '../src/session/sleep/wakeStore.ts';
import { makeMachine, makeSession } from './helpers.ts';

const resources: Array<{ root: string; child: ReturnType<typeof Bun.spawn> }> = [];
afterEach(async () => {
  for (const { root, child } of resources.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
async function fixture(deadlineMs?: number) {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-sleep-test-'));
  const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
  const parent = makeSession({
    name: 'parent',
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
    dir: root,
  });
  const policy: DelegatedPolicy = {
    access: 'read-only',
    readScope: 'host',
    workspace: root,
    network: false,
  };
  const delegation = DelegationSchema.parse({
    ...(deadlineMs === undefined
      ? {}
      : { deadlineAt: new Date(Date.now() + deadlineMs).toISOString() }),
    parent: {
      target: managedPeer(m.rcPrefix, parent),
      registrationGeneration: parent.registrationGeneration,
    },
    policy,
    requestId: crypto.randomUUID(),
    policyDigest: createHash('sha256').update(stableJson(policy)).digest('hex'),
  });
  const s = makeSession({
    name: 'child',
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
    dir: root,
    delegation,
  });
  await writeSessionsUnlocked(m, [s]);
  await seedNativeSelection(m, s, {
    runtime: 'codex',
    model: { provider: 'openai', model: 'test-model' },
    mode: 'default',
  });
  const inputPath = join(root, 'input.json');
  writeFileSync(inputPath, JSON.stringify({ m, s }), { mode: 0o600 });
  const child = Bun.spawn(
    [process.execPath, new URL('./fixtures/sleepOwner.ts', import.meta.url).pathname, inputPath],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
  );
  resources.push({ root, child });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done) throw Error('Owner fixture failed before readiness');
  const identity: unknown = JSON.parse(new TextDecoder().decode(first.value));
  if (
    !identity ||
    typeof identity !== 'object' ||
    !('pid' in identity) ||
    !('providerPid' in identity) ||
    typeof identity.pid !== 'number' ||
    typeof identity.providerPid !== 'number'
  )
    throw Error('Invalid owner fixture');
  const projection = new OwnedCodexProjection(m, s, identity.providerPid);
  // One instant for both ends of the lease: a reader refuses one longer than its TTL as clock skew,
  // and two clock reads a millisecond apart made it 5001 ms.
  const now = Date.now();
  const snapshot = {
    ...projection.snapshot(),
    pid: identity.pid,
    providerPid: identity.providerPid,
    connected: true,
    state: 'idle',
    reason: null,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5000).toISOString(),
  };
  const writer = new OwnedCodexStatusWriter(m, s.name);
  await writer.write({ ...snapshot, state: 'idle' });
  return { root, child, m, s, writer, snapshot };
}
test('idle proof measures exact producer and changes revision when new input is queued', async () => {
  const f = await fixture();
  const before = idleProof(f.m, f.s);
  expect(before.eligible).toBe(true);
  expect(before).toMatchObject({ run: 'idle', queue: 0, approvals: 0, children: 0, background: 0 });
  const message = buildEnvelope(cliPrincipal('host-a'), managedPeer('host-a', f.s), 'queued work', {
    defer: false,
    notBefore: null,
    task: null,
  });
  await appendMessageOnce(f.m, message, new AbortController().signal);
  const after = idleProof(f.m, f.s);
  expect(after.revision).not.toBe(before.revision);
  expect(after.reason).toBe('queued-input');
  await expect(
    sleepSession(
      f.m,
      {
        target: managedPeer('host-a', f.s),
        registrationGeneration: f.s.registrationGeneration ?? '',
        operationId: crypto.randomUUID(),
        revision: before.revision,
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(readSleep(f.m, f.s)).toBeNull();
  expect(f.child.exitCode).toBeNull();
});
test('approval, stale state, owned child and unbounded native work refuse sleep rather than guess zero', async () => {
  const f = await fixture();
  await f.writer.write({ ...f.snapshot, state: 'waiting-approval' });
  expect(idleProof(f.m, f.s).eligible).toBe(false);
  await f.writer.write({
    ...f.snapshot,
    state: 'idle',
    observedAt: new Date(Date.now() - 10000).toISOString(),
    expiresAt: new Date(Date.now() - 5000).toISOString(),
  });
  expect(idleProof(f.m, f.s).run).toBe('unknown');
  await f.writer.write({ ...f.snapshot, state: 'idle' });
  if (f.s.delegation === undefined) throw Error('missing delegated fixture');
  const child = makeSession({
    name: 'grandchild',
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
    delegation: {
      ...f.s.delegation,
      parent: {
        target: managedPeer('host-a', f.s),
        registrationGeneration: f.s.registrationGeneration ?? '',
      },
    },
  });
  await writeSessionsUnlocked(f.m, [f.s, child]);
  expect(idleProof(f.m, f.s).reason).toBe('owned-children');
  expect(idleProof(f.m, { ...f.s, delegation: undefined }).reason).toBe(
    'unbounded-native-background-state',
  );
});
test('sleep intent persists across fresh readers and processReleased checks process incarnation', async () => {
  const f = await fixture();
  const proof = idleProof(f.m, f.s);
  const row = {
    target: managedPeer('host-a', f.s),
    registrationGeneration: f.s.registrationGeneration ?? '',
    operationId: crypto.randomUUID(),
    proof,
    phase: 'requested',
    updatedAt: new Date().toISOString(),
  };
  await writeSleep(f.m, f.s, { ...row, phase: 'requested' });
  expect(sleepBlocksStart(f.m, f.s)).toBe(true);
  expect(readSleep({ ...f.m }, { ...f.s })?.operationId).toBe(row.operationId);
  expect(processesReleased({ ...row, phase: 'requested' })).toBe(false);
  f.child.kill('SIGTERM');
  await f.child.exited;
  expect(processesReleased({ ...row, phase: 'requested' })).toBe(true);
});

test('sleep CAS is consumed by its actual owner and retry reuses the durable release receipt', async () => {
  const f = await fixture();
  const proof = idleProof(f.m, f.s);
  expect(proof.eligible).toBe(true);
  const input = {
    target: managedPeer('host-a', f.s),
    registrationGeneration: f.s.registrationGeneration ?? '',
    operationId: crypto.randomUUID(),
    revision: proof.revision,
  };
  const receipt = await sleepSession(f.m, input, new AbortController().signal);
  expect(receipt).toMatchObject({
    state: 'sleeping',
    release: 'processReleased',
    duplicate: false,
  });
  expect(await f.child.exited).toBe(0);
  const retry = await sleepSession(f.m, input, new AbortController().signal);
  expect(retry.duplicate).toBe(true);
  expect(readSleep(f.m, f.s)?.phase).toBe('sleeping');
  await expect(
    sleepSession(f.m, { ...input, revision: '0'.repeat(64) }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

test('cancelled sleeping child stays stopped and cancellation retries confirm the same released work', async () => {
  const f = await fixture();
  if (f.s.delegation === undefined) throw Error('missing delegation');
  const proof = idleProof(f.m, f.s);
  await sleepSession(
    f.m,
    {
      target: managedPeer('host-a', f.s),
      registrationGeneration: f.s.registrationGeneration ?? '',
      operationId: crypto.randomUUID(),
      revision: proof.revision,
    },
    new AbortController().signal,
  );
  const input = {
    parent: f.s.delegation.parent,
    target: managedPeer('host-a', f.s),
    registrationGeneration: f.s.registrationGeneration ?? '',
    operationId: crypto.randomUUID(),
  };
  const first = await cancelDelegation(f.m, input, new AbortController().signal);
  expect(first.stopped).toBe(true);
  expect(delegationStopped(f.m, f.s)).toBe(true);
  expect(await cancelDelegation(f.m, input, new AbortController().signal)).toEqual(first);
  await expect(
    wakeSession(
      f.m,
      {
        target: input.target,
        registrationGeneration: input.registrationGeneration,
        operationId: crypto.randomUUID(),
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'DELEGATION_REFUSED' });
});

test('a completed wake operation cannot wake a subsequent sleep', async () => {
  const f = await fixture();
  const proof = idleProof(f.m, f.s);
  const target = managedPeer('host-a', f.s),
    registrationGeneration = f.s.registrationGeneration ?? '';
  const firstSleep = crypto.randomUUID(),
    wakeId = crypto.randomUUID(),
    secondSleep = crypto.randomUUID();
  const result = SleepReceiptSchema.parse({
    target,
    registrationGeneration,
    operationId: wakeId,
    state: 'awake',
    release: 'processReleased',
    nativeId: f.s.uuid,
    duplicate: false,
  });
  writeWakeOperations(f.m, f.s, [{ operationId: wakeId, sleepOperationId: firstSleep, result }]);
  await writeSleep(f.m, f.s, {
    target,
    registrationGeneration,
    operationId: secondSleep,
    proof,
    phase: 'sleeping',
    updatedAt: new Date().toISOString(),
  });
  expect(
    await wakeSession(
      f.m,
      { target, registrationGeneration, operationId: wakeId },
      new AbortController().signal,
    ),
  ).toEqual({ ...result, duplicate: true });
  expect(readSleep(f.m, f.s)?.operationId).toBe(secondSleep);
  expect(readSleep(f.m, f.s)?.phase).toBe('sleeping');
});

test('a pending wake refuses a superseding sleep before starting its executor', async () => {
  const f = await fixture();
  const target = managedPeer('host-a', f.s),
    registrationGeneration = f.s.registrationGeneration ?? '';
  const currentSleep = crypto.randomUUID();
  await writeSleep(f.m, f.s, {
    target,
    registrationGeneration,
    operationId: currentSleep,
    proof: idleProof(f.m, f.s),
    phase: 'sleeping',
    updatedAt: new Date().toISOString(),
  });
  await expect(
    wakeSleepingSession(f.m, f.s, new AbortController().signal, crypto.randomUUID()),
  ).rejects.toMatchObject({ code: 'SLEEP_SUPERSEDED' });
  expect(readSleep(f.m, f.s)?.operationId).toBe(currentSleep);
  expect(f.child.exitCode).toBeNull();
});

test('a corrupt journal is refused while an absent journal is only missing', async () => {
  const f = await fixture();
  expect(readSleep(f.m, f.s)).toBeNull();
  const { managedRuntimeRoot } = await import('../src/runtime/status.ts');
  writeFileSync(join(managedRuntimeRoot(f.m, f.s), 'sleep.json'), '{invalid', { mode: 0o600 });
  expect(() => readSleep(f.m, f.s)).toThrow('Private journal is unreadable');
});

test('an executor without bounded delegation returns unsupported without changing its lifecycle', async () => {
  const f = await fixture();
  const ordinary = { ...f.s, delegation: undefined };
  await writeSessionsUnlocked(f.m, [ordinary]);
  const proof = idleProof(f.m, ordinary);
  const result = await sleepSession(
    f.m,
    {
      target: managedPeer('host-a', ordinary),
      registrationGeneration: ordinary.registrationGeneration ?? '',
      operationId: crypto.randomUUID(),
      revision: proof.revision,
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ release: 'unsupported', state: 'unchanged' });
  expect(readSleep(f.m, ordinary)).toBeNull();
  expect(f.child.exitCode).toBeNull();
});

test('active cancellation releases its owned provider and leaves an unrelated identical executable alive', async () => {
  const f = await fixture();
  const unrelated = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    if (!f.s.delegation) throw Error('missing delegation');
    const result = await cancelDelegation(
      f.m,
      {
        parent: f.s.delegation.parent,
        target: managedPeer('host-a', f.s),
        registrationGeneration: f.s.registrationGeneration ?? '',
        operationId: crypto.randomUUID(),
      },
      new AbortController().signal,
    );
    expect(result.stopped).toBe(true);
    expect(await f.child.exited).toBe(0);
    expect(unrelated.exitCode).toBeNull();
  } finally {
    unrelated.kill('SIGTERM');
    await unrelated.exited;
  }
});

test('an inherited deadline releases the actually owned provider without a cancel caller', async () => {
  const f = await fixture(2500);
  expect(await f.child.exited).toBe(0);
  expect(delegationStopped(f.m, f.s)).toBe(true);
});

test('an acknowledged cold start returns pending within its bounded wait and keeps its durable wake identity', async () => {
  const f = await fixture();
  const proof = idleProof(f.m, f.s);
  await sleepSession(
    f.m,
    {
      target: managedPeer('host-a', f.s),
      registrationGeneration: f.s.registrationGeneration ?? '',
      operationId: crypto.randomUUID(),
      revision: proof.revision,
    },
    new AbortController().signal,
  );
  const row = readSleep(f.m, f.s);
  if (row === null) throw Error('missing sleep');
  await writeSleep(f.m, f.s, { ...row, phase: 'waking' });
  const input = {
    target: row.target,
    registrationGeneration: row.registrationGeneration,
    operationId: crypto.randomUUID(),
  };
  const m = { ...f.m, codexCorrelationTimeoutMs: 100 };
  const hold = withNativeAdmission(m, f.s, async () => {
    await Bun.sleep(1600);
  });
  await Bun.sleep(50);
  const began = performance.now();
  await expect(wakeSession(m, input, new AbortController().signal)).rejects.toMatchObject({
    code: 'WAKE_PENDING',
  });
  expect(performance.now() - began).toBeLessThan(1400);
  await hold;
  expect(readSleep(m, f.s)?.operationId).toBe(row.operationId);
  expect(readSleep(m, f.s)?.phase).toBe('waking');
});

test('all public control operation waits fit the service transport budget', () => {
  for (const endpoint of Object.values(controlContract.endpoints)) {
    expect('timeout' in endpoint ? endpoint.timeout : 30000).toBeLessThanOrEqual(30000);
  }
});
