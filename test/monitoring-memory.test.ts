import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedPeer } from '../src/chat/identity.ts';
import { FORWARDED_OPERATIONS } from '../src/control/peerOperation.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { controlContract } from '../src/control/schema/contract.ts';
import { ControlRowSchema } from '../src/control/schema/core.ts';
import { UNSEEN } from '../src/events/observe.ts';
import { InventoryRowSchema } from '../src/events/schema.ts';
import { rowStateLabel } from '../src/inventory/rows.ts';
import {
  MEMORY_SAMPLE_MAX_AGE_MS,
  MemorySampler,
  measureDarwinTreeMemory,
  measureLinuxSessionTrees,
  measureLinuxTreeMemory,
  parseSmapsRollupBytes,
} from '../src/monitoring/memory.ts';
import { projectMonitoringRow } from '../src/monitoring/project.ts';
import {
  MonitoringRowReadSchema,
  MonitoringRowSchema,
  MonitoringSnapshotSchema,
  STATUS_MAX_AGE_MS,
  STATUS_MAX_BYTES,
  STATUS_MAX_ITEMS,
} from '../src/monitoring/schema.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { SleepRecordSchema } from '../src/session/sleep/schema.ts';
import { writeSleep } from '../src/session/sleep/store.ts';
import { deriveStatus } from '../src/tui/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('memory measurement (macOS libproc + Linux smaps_rollup parser/fixture + MemorySampler)', () => {
  test('measureDarwinTreeMemory traverses real child processes via proc_listchildpids and returns null for dead PID', async () => {
    if (process.platform !== 'darwin') return;
    const selfBytes = await measureDarwinTreeMemory([process.pid]);
    expect(selfBytes).not.toBeNull();
    if (selfBytes === null) throw new Error('expected measured bytes');
    expect(selfBytes).toBeGreaterThan(0);

    // Dead / nonexistent PID must return null, NEVER 0.
    const missing = await measureDarwinTreeMemory([999_999_999]);
    expect(missing).toBeNull();

    // Real parent -> child tree where child touches 24 MiB: falsifies missing proc_listchildpids.
    // The child keeps the buffer reachable (a global and the timer touch it): an unreferenced one is
    // collected within ~200 ms and the footprint falls back to ~4 MiB before it is measured.
    const parentProc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const child = Bun.spawn([process.execPath, '-e', 'const b = new Uint8Array(24 * 1024 * 1024); for (let i = 0; i < b.length; i += 4096) b[i] = 1; globalThis.held = b; console.log("READY"); setInterval(() => { b[0] ^= 1; }, 1000);'], { stdout: 'pipe' });
const reader = child.stdout.getReader();
await reader.read();
reader.releaseLock();
console.log(JSON.stringify({ parent: process.pid, child: child.pid }));
process.on('SIGTERM', () => { try { child.kill('SIGKILL'); } catch {} process.exit(0); });
setInterval(() => {}, 1000);`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    try {
      const reader = parentProc.stdout.getReader();
      const chunk = await reader.read();
      reader.releaseLock();
      const parsed = JSON.parse(new TextDecoder().decode(chunk.value).trim()) as {
        parent: number;
        child: number;
      };
      const withChild = await measureDarwinTreeMemory([parsed.parent]);
      const childOnly = await measureDarwinTreeMemory([parsed.child]);
      expect(childOnly).not.toBeNull();
      expect(withChild).not.toBeNull();
      expect(childOnly ?? 0).toBeGreaterThan(16 * 1024 * 1024);

      // Kill only the child and re-measure parent: footprint drop proves child was summed.
      process.kill(parsed.child, 'SIGKILL');
      const deadline = Date.now() + 3_000;
      let parentAlone = withChild ?? 0;
      while (Date.now() < deadline) {
        const next = await measureDarwinTreeMemory([parsed.parent]);
        if (next !== null && (withChild ?? 0) - next > 12 * 1024 * 1024) {
          parentAlone = next;
          break;
        }
        await Bun.sleep(50);
      }
      expect((withChild ?? 0) - parentAlone).toBeGreaterThan(12 * 1024 * 1024);
    } finally {
      parentProc.kill('SIGTERM');
      await parentProc.exited;
    }
  });

  test.skipIf(process.platform !== 'linux')(
    'measureLinuxSessionTrees reads live kernel /proc/<pid>/smaps_rollup on Linux',
    () => {
      const measured = measureLinuxSessionTrees(new Map([['self', [process.pid]]]));
      expect(measured.get('self')).toBeGreaterThan(0);
    },
  );

  test('parseSmapsRollupBytes sums Pss + SwapPss and fails closed on missing Pss', () => {
    const sample = [
      '00400000-7fff0000 ---p 00000000 00:00 0 [rollup]',
      'Rss:                4096 kB',
      'Pss:                1200 kB',
      'Swap:                500 kB',
      'SwapPss:             300 kB',
    ].join('\n');
    expect(parseSmapsRollupBytes(sample)).toBe((1200 + 300) * 1024);
    expect(parseSmapsRollupBytes('Rss: 4096 kB\n')).toBeNull();
  });

  test('measureLinuxTreeMemory sums synthetic /proc tree and returns null on missing root smaps_rollup', () => {
    const procRoot = tempDir('stitchmux-fake-proc-');
    // Root PID 1000 -> child 1001 -> grandchild 1002 (transient ENOENT smaps_rollup).
    const writeProc = (
      pid: number,
      ppid: number,
      children: readonly number[],
      pssKb: number | null,
      swapKb = 0,
    ) => {
      const dir = join(procRoot, String(pid));
      const taskDir = join(dir, 'task', String(pid));
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        join(dir, 'stat'),
        `${pid} (bun) S ${ppid} ${pid} ${pid} 0 0 0 0 0 0 0 0 0 0 0 1 0 100\n`,
      );
      writeFileSync(join(taskDir, 'children'), children.join(' '));
      if (pssKb !== null) {
        writeFileSync(join(dir, 'smaps_rollup'), `Pss: ${pssKb} kB\nSwapPss: ${swapKb} kB\n`);
      }
    };
    writeProc(1000, 1, [1001], 2000, 500);
    writeProc(1001, 1000, [1002], 1000, 0);
    writeProc(1002, 1001, [], null); // transient child without smaps_rollup -> skipped cleanly

    expect(measureLinuxTreeMemory([1000], procRoot)).toBe((2000 + 500 + 1000) * 1024);

    // Root without readable smaps_rollup must return null, NEVER 0 or partial child-only sum.
    const brokenRoot = tempDir('stitchmux-fake-proc-broken-');
    const writeBroken = (
      pid: number,
      ppid: number,
      children: readonly number[],
      smaps: string | null,
    ) => {
      const dir = join(brokenRoot, String(pid));
      const taskDir = join(dir, 'task', String(pid));
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        join(dir, 'stat'),
        `${pid} (bun) S ${ppid} ${pid} ${pid} 0 0 0 0 0 0 0 0 0 0 0 1 0 100\n`,
      );
      writeFileSync(join(taskDir, 'children'), children.join(' '));
      if (smaps !== null) writeFileSync(join(dir, 'smaps_rollup'), smaps);
    };
    writeBroken(2000, 1, [2001], null);
    writeBroken(2001, 2000, [], 'Pss: 500 kB\n');
    expect(measureLinuxTreeMemory([2000], brokenRoot)).toBeNull();

    // Batched measureLinuxSessionTrees handles valid + broken sessions in a single /proc pass.
    writeProc(3000, 1, [3001], null);
    writeProc(3001, 3000, [], 500, 0);
    const batched = measureLinuxSessionTrees(
      new Map([
        ['ok', [1000]],
        ['broken', [3000]],
      ]),
      procRoot,
    );
    expect(batched.get('ok')).toBe((2000 + 500 + 1000) * 1024);
    expect(batched.get('broken')).toBeNull();
  });

  test('live native session without tmux never reports memoryBytes=0 before sampling (MemorySampler.memoryFor)', async () => {
    const { OwnedCodexProjection } = await import('../src/agent/codex/owned/projection.ts');
    const { OwnedCodexStatusWriter } = await import('../src/agent/codex/owned/status.ts');
    const root = tempDir('stitchmux-native-mem-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const nativeSession = makeSession({
      name: 'native-only',
      agent: 'codex',
      runtime: 'app-server',
      dir: root,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [nativeSession]);
    const now = Date.now();
    const projection = new OwnedCodexProjection(m, nativeSession, process.pid);
    await new OwnedCodexStatusWriter(m, nativeSession.name).write({
      ...projection.snapshot(),
      pid: process.pid,
      providerPid: process.pid,
      connected: true,
      state: 'idle',
      reason: null,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5_000).toISOString(),
    });
    const sampler = new MemorySampler();
    // Before first refresh, startedAt is undefined (no tmux pane), yet native runtime IS live:
    // rawMemoryFor returns null and projectMonitoringRow MUST emit memoryBytes: null (NEVER 0).
    const beforeSample = projectMonitoringRow(
      m,
      nativeSession,
      undefined,
      null,
      UNSEEN,
      now,
      sampler.memoryFor(nativeSession.name),
    );
    expect(beforeSample.running).toBe(true);
    expect(beforeSample.memoryBytes).toBeNull();

    if (process.platform === 'darwin') {
      await sampler.refresh(m, [nativeSession], new Map());
      const afterSample = projectMonitoringRow(
        m,
        nativeSession,
        undefined,
        null,
        UNSEEN,
        now,
        sampler.memoryFor(nativeSession.name),
      );
      expect(afterSample.running).toBe(true);
      expect(afterSample.memoryBytes).toBeGreaterThan(0);
    }
  });

  test('MemorySampler reports null (never 0) without a fresh sample and bytes once measured', async () => {
    const root = tempDir('stitchmux-sampler-');
    const m = makeMachine({ stateDir: join(root, 'state') });
    const live = makeSession({ name: 'agent-live', agent: 'claude', dir: root });
    const sampler = new MemorySampler();

    expect(sampler.memoryFor(live.name)).toBeNull();
    // A live session whose pane pids are unknown is unmeasured, not empty.
    await sampler.refresh(m, [live], new Map());
    expect(sampler.memoryFor(live.name)).toBeNull();

    if (process.platform === 'darwin') {
      await sampler.refresh(m, [live], new Map([[live.name, [process.pid]]]));
      expect(sampler.memoryFor(live.name)).toBeGreaterThan(0);
      // The same sample read after it went stale is not reported.
      expect(
        sampler.memoryFor(live.name, Date.now() + MEMORY_SAMPLE_MAX_AGE_MS + 1_000),
      ).toBeNull();
    }
  });
});

describe('MonitoringRowSchema, InventoryRowSchema, TUI status, and controlContract parity', () => {
  test('MonitoringRowSchema keeps protocol-1 state="stopped" while carrying additive sleep/pin/memory fields', async () => {
    const root = tempDir('stitchmux-mon-row-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const s = makeSession({
      name: 'agent-a',
      agent: 'claude',
      dir: root,
      pinned: true,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSleep(
      m,
      s,
      SleepRecordSchema.parse({
        target: managedPeer(m.rcPrefix, s),
        registrationGeneration: s.registrationGeneration,
        operationId: crypto.randomUUID(),
        phase: 'sleeping',
        updatedAt: new Date().toISOString(),
        proof: {
          target: managedPeer(m.rcPrefix, s),
          registrationGeneration: s.registrationGeneration,
          revision: 'a'.repeat(64),
          generation: null,
          eligible: true,
          run: 'idle',
          queue: 0,
          approvals: 0,
          children: 0,
          background: 0,
          reason: null,
          observedAt: new Date().toISOString(),
          processes: [],
        },
      }),
    );
    const row = projectMonitoringRow(m, s, undefined, null, UNSEEN, Date.now(), 0);
    expect(row.state).toBe('stopped');
    expect(row.sleeping).toBe(true);
    expect(row.pinned).toBe(true);
    expect(row.memoryBytes).toBe(0);
    expect(row.registrationGeneration).toBe(s.registrationGeneration ?? null);

    // A row from a producer older than these fields still reads; the producer's own schema requires them.
    const {
      sleeping: _s,
      pinned: _p,
      memoryBytes: _m,
      registrationGeneration: _g,
      ...legacy
    } = row;
    expect(MonitoringRowReadSchema.parse(legacy).state).toBe('stopped');
    expect(MonitoringRowSchema.safeParse(legacy).success).toBe(false);
  });

  test('InventoryRowSchema carries sleeping/pinned and deliberately omits memoryBytes', () => {
    expect('sleeping' in InventoryRowSchema.shape).toBe(true);
    expect('pinned' in InventoryRowSchema.shape).toBe(true);
    expect('memoryBytes' in InventoryRowSchema.shape).toBe(false);
  });

  test('TUI deriveStatus keeps sleeping active=false (0% spinner churn) and rowStateLabel prioritizes archived', () => {
    const sleepingStatus = deriveStatus({
      running: false,
      isWorking: false,
      lastMessage: null,
      sleeping: true,
    });
    expect(sleepingStatus.key).toBe('sleeping');
    expect(sleepingStatus.active).toBe(false);

    expect(rowStateLabel('stopped', false, false, true)).toBe('sleeping');
    expect(rowStateLabel('stopped', false, true, true)).toBe('archived');
    expect(rowStateLabel('idle', true, false, true)).toBe('idle');
  });

  test('controlContract exposes session.pin with effect=write and forwards sleep/wake/idle/pin', () => {
    expect(controlContract.endpoints['session.pin'].effect).toBe('write');
    expect(controlContract.endpoints['session.pin'].idempotent).toBe(true);
    for (const op of ['session.idle', 'session.sleep', 'session.wake', 'session.pin'] as const) {
      expect(FORWARDED_OPERATIONS.includes(op)).toBe(true);
    }
    // ControlRowSchema accepts additive pinned, memoryBytes, and registrationGeneration strictly.
    const s = makeSession({ name: 'agent-a', agent: 'claude' });
    const nowIso = new Date().toISOString();
    const parsed = ControlRowSchema.parse({
      identity: managedPeer('host-a', s),
      registrationGeneration: crypto.randomUUID(),
      runtime: 'cli',
      pinned: true,
      memoryBytes: 0,
      sleep: {
        phase: 'sleeping',
        operationId: crypto.randomUUID(),
        updatedAt: nowIso,
      },
      state: 'stopped',
      availability: 'live',
      reason: null,
      observedAt: nowIso,
      expiresAt: nowIso,
      turn: null,
      model: null,
      selection: null,
      nativeSelection: null,
      capabilities: {
        message: true,
        start: true,
        interrupt: false,
        wait: false,
      },
    });
    expect(parsed.pinned).toBe(true);
    expect(parsed.memoryBytes).toBe(0);
    expect(parsed.sleep?.phase).toBe('sleeping');
  });

  test('ControlPublisher prioritizes archived over sleeping and preserves live state during requested teardown', async () => {
    const root = tempDir('stitchmux-ctrl-pub-');
    const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const sleeping = makeSession({
      name: 'agent-sleep',
      agent: 'claude',
      dir: root,
      pinned: true,
      registrationGeneration: crypto.randomUUID(),
    });
    const archivedSleeping = makeSession({
      name: 'agent-arch',
      agent: 'claude',
      dir: root,
      archived: true,
      registrationGeneration: crypto.randomUUID(),
    });
    const liveRequested = makeSession({
      name: 'agent-req',
      agent: 'claude',
      dir: root,
      registrationGeneration: crypto.randomUUID(),
    });
    await writeSessionsUnlocked(m, [sleeping, archivedSleeping, liveRequested]);

    const writeFake = (s: typeof sleeping, phase: 'sleeping' | 'requested') =>
      writeSleep(
        m,
        s,
        SleepRecordSchema.parse({
          target: managedPeer(m.rcPrefix, s),
          registrationGeneration: s.registrationGeneration,
          operationId: crypto.randomUUID(),
          phase,
          updatedAt: nowIso,
          proof: {
            target: managedPeer(m.rcPrefix, s),
            registrationGeneration: s.registrationGeneration,
            revision: 'a'.repeat(64),
            generation: null,
            eligible: true,
            run: 'idle',
            queue: 0,
            approvals: 0,
            children: 0,
            background: 0,
            reason: null,
            observedAt: nowIso,
            processes: [],
          },
        }),
      );
    await writeFake(sleeping, 'sleeping');
    await writeFake(archivedSleeping, 'sleeping');
    await writeFake(liveRequested, 'requested');

    const snapshot = MonitoringSnapshotSchema.parse({
      protocol: 1,
      version: '0.0.0-test',
      generation: crypto.randomUUID(),
      sequence: 1,
      pid: process.pid,
      rcPrefix: m.rcPrefix,
      scope: 'managed',
      observedAt: nowIso,
      generatedAt: nowIso,
      refreshDurationMs: 1,
      maxAgeMs: STATUS_MAX_AGE_MS,
      limits: { items: STATUS_MAX_ITEMS, bytes: STATUS_MAX_BYTES },
      omitted: 0,
      sessions: [
        projectMonitoringRow(m, sleeping, undefined, null, UNSEEN, now, 0),
        projectMonitoringRow(m, archivedSleeping, undefined, null, UNSEEN, now, 0),
        projectMonitoringRow(m, liveRequested, Math.floor(now / 1000), null, UNSEEN, now, 12_345),
      ],
    });
    const publisher = new ControlPublisher(m);
    publisher.publish(m, snapshot);
    const out = publisher.read(now);

    const sleepRow = out.sessions.find((r) => r.identity.session === 'agent-sleep');
    const archRow = out.sessions.find((r) => r.identity.session === 'agent-arch');
    const reqRow = out.sessions.find((r) => r.identity.session === 'agent-req');

    expect(sleepRow?.state).toBe('stopped');
    expect(sleepRow?.reason).toBe('sleeping');
    expect(sleepRow?.pinned).toBe(true);
    expect(sleepRow?.memoryBytes).toBe(0);
    expect(sleepRow?.sleep?.phase).toBe('sleeping');

    // Archived wins over historical sleep.json: no sleep block, reason is not 'sleeping'.
    expect(archRow?.sleep).toBeUndefined();
    expect(archRow?.reason).not.toBe('sleeping');

    // Live process during requested teardown stays running/live, NOT prematurely stopped!
    expect(reqRow?.reason).not.toBe('sleeping');
    expect(reqRow?.memoryBytes).toBe(12_345);
  });
});
