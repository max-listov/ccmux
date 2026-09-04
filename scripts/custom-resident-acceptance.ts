import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSessions } from '../src/config/sessions.ts';
import type { ControlCreateReceipt } from '../src/control/schema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { check, type NativeImageProbe, report } from './native-image-steering-fixture.ts';

/** Run in a background acceptance process; never block an interactive agent turn on this window. */
export async function customResident(p: NativeImageProbe, receipt: ControlCreateReceipt) {
  const session = loadSessions(p.machine).find((row) => row.uuid === receipt.target.threadId);
  check(session, 'Resident registration missing');
  const snapshot = readManagedRuntimeStatus(p.machine, session).snapshot;
  check(snapshot, 'Positive live baseline missing');
  const database = join(managedRuntimeRoot(p.machine, session), 'conversation.sqlite');
  const before = await stat(database);
  const beforeWal = await stat(`${database}-wal`).catch(() => null);
  const frame = await p.service['native.read']({ target: receipt.target });
  check(frame.baseline.length > 0, 'Read proof needs nonempty native content');
  const latencies: number[] = [];
  const read = async () => {
    const start = performance.now();
    const row = await p.service['session.get']({ target: receipt.target });
    check(row.availability === 'live', 'Prepared reader lost its producer');
    latencies.push(performance.now() - start);
  };
  for (let n = 0; n < 100; n++) await read();
  for (let n = 0; n < 10; n++) await Promise.all(Array.from({ length: 10 }, read));
  const measurement = () => {
    const result = Bun.spawnSync(['ps', '-p', String(snapshot.pid), '-o', 'time=', '-o', 'rss='], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    check(result.exitCode === 0, 'Resident process disappeared');
    const fields = result.stdout.toString().trim().split(/\s+/);
    const parts = (fields[0] ?? '').split(':').map(Number);
    const cpu = parts.length === 2 ? (parts[0] ?? 0) * 60 + (parts[1] ?? 0) : NaN;
    const rssKiB = Number(fields[1]);
    check(Number.isFinite(cpu) && Number.isFinite(rssKiB), 'Process measurement unavailable');
    return { cpu, rssKiB };
  };
  const start = performance.now(),
    baseline = measurement();
  let maxRssKiB = baseline.rssKiB,
    samples = 0;
  report('resident-started', { pid: snapshot.pid, windowMs: 900_000, baseline });
  while (performance.now() - start < 900_000) {
    await Bun.sleep(5000);
    await read();
    const current = measurement();
    maxRssKiB = Math.max(maxRssKiB, current.rssKiB);
    samples++;
  }
  const last = measurement(),
    elapsedMs = performance.now() - start;
  const after = await stat(database),
    afterWal = await stat(`${database}-wal`).catch(() => null);
  check(
    before.mtimeMs === after.mtimeMs && beforeWal?.mtimeMs === afterWal?.mtimeMs,
    'Prepared reads mutated canonical history',
  );
  const final = await p.service['native.read']({ target: receipt.target });
  check(
    final.nativeProfile?.turnId === frame.nativeProfile?.turnId,
    'Resident window started another model run',
  );
  const statusBytes = (await readFile(join(managedRuntimeRoot(p.machine, session), 'status.json')))
    .byteLength;
  check(statusBytes <= 128 * 1024, 'Prepared status exceeded its bound');
  latencies.sort((a, b) => a - b);
  report('resident-pass', {
    elapsedMs,
    samples,
    reads: latencies.length,
    cpuSeconds: last.cpu - baseline.cpu,
    cpuPercent: ((last.cpu - baseline.cpu) * 100_000) / elapsedMs,
    baselineRssKiB: baseline.rssKiB,
    finalRssKiB: last.rssKiB,
    maxRssKiB,
    p50Ms: latencies[Math.floor(latencies.length * 0.5)],
    p95Ms: latencies[Math.floor(latencies.length * 0.95)],
    statusBytes,
    canonicalStoreUnchanged: true,
  });
}
