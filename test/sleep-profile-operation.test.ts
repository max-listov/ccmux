import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedCodexProjection } from '../src/agent/codex/owned/projection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/owned/status.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { seedNativeSelection } from '../src/runtime/selection.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { sleepIdleSessions } from '../src/session/sleep/autoSleep.ts';
import { sleepSession } from '../src/session/sleep/operations.ts';
import { withProfilePolicyLock } from '../src/session/sleep/profilePolicy.ts';
import { idleProof } from '../src/session/sleep/proof.ts';
import { readSleep } from '../src/session/sleep/store.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import codexFrames from './fixtures/codex-pane/v0.159.1.json';
import { makeMachine, makeSession } from './helpers.ts';

// The profile policy (`minAwakePerProfile`) is guarded here through `sleepSession` itself — the
// operation every caller reaches — not through `withProfilePolicyLock` or `evaluateSleepPolicy`
// called by hand, so removing the lock or the health rule from the operation turns these red.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function machine(): MachineConfig {
  const root = realpathSync(mkdtempSync('/tmp/stitchmux-sleep-profile-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const tmuxBin = Bun.which('tmux');
  if (tmuxBin === null) throw Error('tmux is required for the sleep profile tests');
  const m = makeMachine({
    stateDir: join(root, 'state'),
    rcPrefix: 'host-a',
    tmuxBin,
    tmuxSocket: `stitchmux-sleep-profile-${process.pid}-${crypto.randomUUID()}`,
    idleSleep: {
      enabled: true,
      idleAfterMinutes: 60,
      minAwakePerProfile: 1,
      checkIntervalSeconds: 60,
    },
  });
  cleanups.push(() => {
    Bun.spawnSync(tmuxArgv(m, 'kill-server'));
  });
  return m;
}

function nativeCodex(m: MachineConfig, name: string): Session {
  return makeSession({
    name,
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
    dir: m.stateDir,
  });
}

/** The tmux session a non-delegated native Codex keeps for its terminal client, showing `frame`. */
function terminal(m: MachineConfig, name: string, frame: string): void {
  const file = join(m.stateDir, `${name}.frame`);
  writeFileSync(file, frame);
  Bun.spawnSync(
    tmuxArgv(
      m,
      'new-session',
      '-d',
      '-x',
      '120',
      '-y',
      '40',
      '-s',
      name,
      `cat ${file}; exec sleep 600`,
    ),
  );
}

/**
 * A live owned runtime for `s`: owner + provider processes and a status lease in `state`, renewed
 * every second while the owner lives, as a real owner does — a single write expires after five
 * seconds, which a loaded machine reaches mid-test. `stale` writes one lease that already expired.
 */
async function owner(
  m: MachineConfig,
  s: Session,
  state: 'idle' | 'unknown' | 'working' | 'stale' = 'idle',
) {
  await seedNativeSelection(m, s, {
    runtime: 'codex',
    model: { provider: 'openai', model: 'test-model' },
    mode: 'default',
  });
  const input = join(m.stateDir, `${s.name}.input.json`);
  writeFileSync(input, JSON.stringify({ m, s }), { mode: 0o600 });
  const child = Bun.spawn(
    [process.execPath, new URL('./fixtures/sleepOwner.ts', import.meta.url).pathname, input],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
  );
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  cleanups.push(async () => {
    clearInterval(heartbeat);
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done) throw Error('owner fixture failed before readiness');
  const identity = JSON.parse(new TextDecoder().decode(first.value)) as {
    pid: number;
    providerPid: number;
  };
  const writer = new OwnedCodexStatusWriter(m, s.name);
  // One projection: its generation is part of the idle proof, so a lease renewal keeps it.
  const base = new OwnedCodexProjection(m, s, identity.providerPid).snapshot();
  const write = (next: 'idle' | 'unknown' | 'working', now = Date.now()) =>
    writer.write({
      ...base,
      pid: identity.pid,
      providerPid: identity.providerPid,
      connected: true,
      state: next,
      reason: null,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5000).toISOString(),
    });
  if (state === 'stale') {
    await write('idle', Date.now() - 60_000);
  } else {
    await write(state);
    heartbeat = setInterval(() => {
      if (child.exitCode === null) void write(state);
    }, 1_000);
    void child.exited.then(() => clearInterval(heartbeat));
  }
  return { child };
}

async function request(m: MachineConfig, s: Session) {
  const proof = await idleProof(m, s);
  expect(proof).toMatchObject({ eligible: true });
  return {
    target: managedPeer(m.rcPrefix, s),
    registrationGeneration: s.registrationGeneration ?? '',
    operationId: crypto.randomUUID(),
    revision: proof.revision,
  };
}

test('two concurrent sleeps of the last two awake sessions of a profile leave one awake', async () => {
  const m = machine();
  const a = nativeCodex(m, 'agent-a');
  const b = nativeCodex(m, 'agent-b');
  await writeSessionsUnlocked(m, [a, b]);
  terminal(m, a.name, codexFrames.idle);
  terminal(m, b.name, codexFrames.idle);
  await owner(m, a);
  await owner(m, b);
  await Bun.sleep(300);
  const [inputA, inputB] = await Promise.all([request(m, a), request(m, b)]);

  const results = await Promise.allSettled([
    sleepSession(m, inputA, AbortSignal.timeout(15_000)),
    sleepSession(m, inputB, AbortSignal.timeout(15_000)),
  ]);

  const slept = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  expect(slept).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
    code: 'MIN_AWAKE_PER_PROFILE',
  });
  const phases = [readSleep(m, a)?.phase ?? null, readSleep(m, b)?.phase ?? null];
  expect(phases.filter((phase) => phase === 'sleeping')).toHaveLength(1);
  expect(phases.filter((phase) => phase === null)).toHaveLength(1);
});

test('a sleep decision waits for the host profile-policy lock another decision holds', async () => {
  const m = machine();
  const target = nativeCodex(m, 'agent-a');
  const peer = nativeCodex(m, 'agent-b');
  await writeSessionsUnlocked(m, [target, peer]);
  terminal(m, target.name, codexFrames.idle);
  terminal(m, peer.name, codexFrames.idle);
  await owner(m, target);
  await owner(m, peer);
  await Bun.sleep(300);
  const input = await request(m, target);

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  // Another process's decision: the daemon's auto-sleep pass or a CLI `stitchmux sleep`.
  const other = withProfilePolicyLock(m, async () => {
    entered();
    await held;
  });
  await holding;

  let settled = false;
  const sleeping = sleepSession(m, input, AbortSignal.timeout(15_000)).finally(() => {
    settled = true;
  });
  await Bun.sleep(1_000);
  expect(settled).toBe(false);
  expect(readSleep(m, target)).toBeNull();

  release();
  await other;
  expect(await sleeping).toMatchObject({ state: 'sleeping' });
});

for (const peerState of ['unknown', 'stopped', 'not-running', 'tui-unreadable'] as const) {
  test(`a ${peerState} peer does not count as the profile's awake session`, async () => {
    const m = machine();
    const target = nativeCodex(m, 'agent-a');
    const peer =
      peerState === 'not-running' || peerState === 'tui-unreadable'
        ? makeSession({
            name: 'agent-b',
            agent: 'codex',
            registrationGeneration: crypto.randomUUID(),
            dir: m.stateDir,
          })
        : nativeCodex(m, 'agent-b');
    await writeSessionsUnlocked(m, [target, peer]);
    terminal(m, target.name, codexFrames.idle);
    await owner(m, target);
    if (peerState === 'unknown') await owner(m, peer, 'unknown');
    // A live TUI peer whose pane shows no recognisable composer reads as `unknown`, as a failed
    // capture does.
    if (peerState === 'tui-unreadable') terminal(m, peer.name, 'loading…');
    if (peerState === 'stopped') await owner(m, peer, 'stale');
    await Bun.sleep(300);
    const input = await request(m, target);

    await expect(sleepSession(m, input, AbortSignal.timeout(15_000))).rejects.toMatchObject({
      code: 'MIN_AWAKE_PER_PROFILE',
    });
    expect(readSleep(m, target)).toBeNull();
  });
}

test('a healthy idle peer lets the other session of its profile sleep', async () => {
  const m = machine();
  const target = nativeCodex(m, 'agent-a');
  const peer = nativeCodex(m, 'agent-b');
  await writeSessionsUnlocked(m, [target, peer]);
  terminal(m, target.name, codexFrames.idle);
  terminal(m, peer.name, codexFrames.idle);
  await owner(m, target);
  await owner(m, peer);
  await Bun.sleep(300);
  const receipt = await sleepSession(m, await request(m, target), AbortSignal.timeout(15_000));
  expect(receipt).toMatchObject({ state: 'sleeping' });
});

describe('session.sleep-idle pass', () => {
  // Two hours from now every session here is idle past an hour; the pass reads that clock.
  const later = () => Date.now() + 2 * 3_600_000;
  const byName = (receipts: Awaited<ReturnType<typeof sleepIdleSessions>>) =>
    Object.fromEntries(receipts.map((r) => [r.target.session, [r.outcome, r.code]]));

  async function sessions(...specs: Array<{ name: string; pinned?: boolean }>) {
    const m = machine();
    const all = specs.map((spec) => ({
      ...nativeCodex(m, spec.name),
      pinned: spec.pinned === true,
    }));
    await writeSessionsUnlocked(m, all);
    for (const s of all) terminal(m, s.name, codexFrames.idle);
    const owners = await Promise.all(all.map((s) => owner(m, s)));
    await Bun.sleep(300);
    return { m, all, owners };
  }

  test('sleeps the idle and keeps the profile’s last awake session, with its code', async () => {
    const { m, all } = await sessions({ name: 'agent-a' }, { name: 'agent-b' });
    const outcomes = byName(
      await sleepIdleSessions(m, { idleAfterMs: 3_600_000, dryRun: false, now: later() }),
    );
    const pair = [outcomes['agent-a'], outcomes['agent-b']];
    expect(pair).toContainEqual(['slept', null]);
    expect(pair).toContainEqual(['skipped', 'MIN_AWAKE_PER_PROFILE']);
    expect(all.filter((s) => readSleep(m, s)?.phase === 'sleeping')).toHaveLength(1);
  });

  test('a pinned session is skipped and, awake, keeps the profile’s minimum for the idle one', async () => {
    const { m, all } = await sessions({ name: 'agent-a' }, { name: 'agent-c', pinned: true });
    const outcomes = byName(
      await sleepIdleSessions(m, { idleAfterMs: 3_600_000, dryRun: false, now: later() }),
    );
    expect(outcomes).toEqual({
      'agent-a': ['slept', null],
      'agent-c': ['skipped', 'PINNED_SESSION'],
    });
    expect(readSleep(m, all[1] as Session)).toBeNull();
  });

  test('a dry run answers the same way and changes nothing', async () => {
    const { m, all, owners } = await sessions({ name: 'agent-a' }, { name: 'agent-b' });
    const outcomes = byName(
      await sleepIdleSessions(m, { idleAfterMs: 3_600_000, dryRun: true, now: later() }),
    );
    const pair = [outcomes['agent-a'], outcomes['agent-b']];
    expect(pair).toContainEqual(['would-sleep', null]);
    expect(pair).toContainEqual(['skipped', 'MIN_AWAKE_PER_PROFILE']);
    expect(all.map((s) => readSleep(m, s))).toEqual([null, null]);
    expect(owners.every(({ child }) => child.exitCode === null)).toBe(true);
  });

  test('a busy session is skipped as not idle, and a candidate past the budget is not attempted', async () => {
    const m = machine();
    const busy = nativeCodex(m, 'agent-a');
    await writeSessionsUnlocked(m, [busy]);
    terminal(m, busy.name, codexFrames.idle);
    await owner(m, busy, 'working');
    await Bun.sleep(300);
    const noMinimum = { ...m, idleSleep: { ...m.idleSleep, minAwakePerProfile: 0 } };
    expect(
      byName(
        await sleepIdleSessions(noMinimum, { idleAfterMs: 3_600_000, dryRun: false, now: later() }),
      ),
    ).toEqual({ 'agent-a': ['skipped', 'NOT_IDLE'] });
    expect(
      byName(
        await sleepIdleSessions(noMinimum, {
          idleAfterMs: 3_600_000,
          dryRun: false,
          now: later(),
          deadlineMs: Date.now() - 1,
        }),
      ),
    ).toEqual({ 'agent-a': ['not-attempted', null] });
    expect(readSleep(m, busy)).toBeNull();
  });
});
