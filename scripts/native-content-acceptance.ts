#!/usr/bin/env bun
import { join } from 'node:path';
import { loadSessions } from '../src/config/sessions.ts';
import type { ContentRecord } from '../src/content/schema.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { readManagedRuntimeStatus } from '../src/runtime/status.ts';
import type { ManagedPeer } from '../src/types.ts';
import {
  check,
  modelCatalog,
  type NativeImageProbe,
  nativeImageProbe,
  report,
  sha,
  until,
} from './native-image-steering-fixture.ts';

type Item = { text: string; offset: number; revision: number; complete: boolean; omitted: number };
function apply(items: Map<string, Item>, record: ContentRecord) {
  if (record.kind !== 'assistant') return;
  const key = JSON.stringify([record.turnId, record.itemId]);
  const before = items.get(key);
  if (record.operation === 'replace') {
    items.set(key, {
      text: record.text ?? '',
      offset: record.offsetBytes,
      revision: record.revision,
      complete: record.complete,
      omitted: record.omittedBytes,
    });
  } else if (record.operation === 'append') {
    if (before === undefined) {
      items.set(key, {
        text: record.text ?? '',
        offset: record.offsetBytes,
        revision: record.revision,
        complete: record.complete && record.prefixKnown,
        omitted: record.offsetBytes,
      });
      return;
    }
    check(
      before.revision === record.revision &&
        before.offset + Buffer.byteLength(before.text) === record.offsetBytes,
      'Content append continuity differs',
    );
    before.text += record.text ?? '';
    before.complete = record.complete;
  }
}
function cpu(pid: number): number {
  const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'time='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(result.exitCode === 0, 'Observer CPU probe failed');
  const fields = result.stdout.toString().trim().split(':').map(Number);
  check(fields.length === 2 && fields.every(Number.isFinite), 'Observer CPU format differs');
  return (fields[0] ?? 0) * 60 + (fields[1] ?? 0);
}
async function run(
  p: NativeImageProbe,
  target: ManagedPeer,
  registrationGeneration: string,
  readers: number,
) {
  await until('idle before content run', async () => {
    try {
      return (await p.service.get({ target })).state === 'idle';
    } catch {
      return false;
    }
  });
  const before = await p.service.native({ target });
  const client = createControlClient({ socket: controlSocket(p.machine) });
  const abort = new AbortController();
  const started = performance.now(),
    ownCpu = process.cpuUsage();
  const session = loadSessions(p.machine).find((row) => row.uuid === target.threadId);
  check(session, 'Content probe registration missing');
  const snapshot = readManagedRuntimeStatus(p.machine, session).snapshot;
  check(snapshot, 'Content observer is unavailable');
  const observerCpu = cpu(snapshot.pid);
  const stats = Array.from({ length: readers }, () => ({
    frames: 0,
    bytes: 0,
    updates: 0,
    resets: 0,
    latencyMs: [] as number[],
    terminal: false,
    items: new Map<string, Item>(),
    sequence: before.sequence,
  }));
  const streams = await Promise.all(
    stats.map(() =>
      client.watchNative.withOptions(
        { target, cursor: { generation: before.generation, sequence: before.sequence } },
        { signal: abort.signal },
      ),
    ),
  );
  let readerError: unknown = null;
  const collectors = streams.map(async (stream, index) => {
    const stat = stats[index];
    check(stat, 'Reader missing');
    try {
      for await (const frame of stream) {
        stat.frames++;
        stat.bytes += Buffer.byteLength(JSON.stringify(frame));
        check(
          frame.generation === before.generation && frame.status === 'live',
          'Observer changed during native turn',
        );
        if (frame.reset !== null) {
          stat.resets++;
          stat.items.clear();
          for (const record of frame.baseline) {
            apply(stat.items, record);
            if (record.kind === 'terminal' && record.sequence > before.sequence)
              stat.terminal = true;
          }
        }
        for (const record of frame.records) {
          if (record.sequence <= stat.sequence) continue;
          if (record.kind === 'assistant') {
            stat.updates++;
            stat.latencyMs.push(Math.max(0, Date.now() - Date.parse(record.at)));
          }
          apply(stat.items, record);
          if (record.kind === 'terminal') stat.terminal = true;
        }
        stat.sequence = frame.sequence;
        if (index === readers - 1 && readers > 1) await Bun.sleep(250);
      }
    } catch (error) {
      if (!abort.signal.aborted) readerError = error;
    }
  });
  try {
    await p.service.message({
      target,
      messageId: crypto.randomUUID(),
      body: 'Output exactly 220 separate numbered lines. Each line must contain its number followed by: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. Print every line literally, no omissions, ellipses, code, tools or commentary. This measures streamed text; do not summarize or abbreviate.',
    });
    await until(
      'all content readers observed completion',
      async () => {
        if (readerError !== null) throw readerError;
        const waited = await p.service.wait({ target, timeoutMs: 500 });
        check(waited.outcome !== 'failed', 'Native content turn failed');
        return stats.every((stat) => stat.terminal) && waited.outcome === 'completed';
      },
      240_000,
    );
    const history = await p.service.history({ target, registrationGeneration, limit: 8 });
    const final = history.entries.find((row) => row.kind === 'assistant');
    check(final?.text, 'Native final text missing');
    for (const stat of stats) {
      const item = [...stat.items.values()].find(
        (item) => item.complete && item.text === final.text,
      );
      check(
        item && item.omitted === 0 && Buffer.byteLength(item.text) > 8192,
        'Stream did not recover complete native output above old tail',
      );
      check(stat.updates > 2, 'Content did not stream incrementally before completion');
    }
    const costs = process.cpuUsage(ownCpu);
    report('content-stream', {
      runtime: target.agent,
      readers,
      durationMs: performance.now() - started,
      observerCpuSeconds: cpu(snapshot.pid) - observerCpu,
      readerCpuMs: (costs.user + costs.system) / 1000,
      textBytes: Buffer.byteLength(final.text),
      nativeTextSha256: sha(final.text),
      readersEvidence: stats.map((stat) => ({
        frames: stat.frames,
        bytes: stat.bytes,
        updates: stat.updates,
        resets: stat.resets,
        maximumLatencyMs: Math.max(...stat.latencyMs),
        averageLatencyMs: stat.latencyMs.reduce((a, b) => a + b, 0) / stat.latencyMs.length,
      })),
      slowReader: readers > 1,
      completeNativeMatch: true,
    });
  } catch (error) {
    report('content-stream-failed', {
      runtime: target.agent,
      readers,
      readersEvidence: stats.map(({ items: _items, latencyMs: _latency, ...stat }) => stat),
    });
    throw error;
  } finally {
    abort.abort();
    await Promise.all(collectors);
    await client.close();
  }
}
const p = await nativeImageProbe();
try {
  const runtimes: Array<'codex' | 'opencode'> = Bun.argv.includes('--opencode-only')
    ? ['opencode']
    : ['codex', 'opencode'];
  for (const runtime of runtimes) {
    const models = await modelCatalog(p, runtime);
    const model = models.find((row) =>
      runtime === 'codex'
        ? row.id === 'gpt-5.6-luna'
        : row.provider === 'openrouter' && row.id === 'google/gemini-2.5-flash',
    );
    check(model, 'Configured content model unavailable');
    const created = await p.service.create({
      runtime,
      requestId: crypto.randomUUID(),
      name: `${runtime}-content`,
      workspace: join(p.root, runtime),
      modelSelection: {
        provider: runtime === 'codex' ? 'openai' : 'openrouter',
        model: model.model ?? model.id,
      },
      ...(runtime === 'codex' ? { launchRecipe: { id: 'native', revision: '1' } } : {}),
    });
    await run(p, created.target, created.registrationGeneration, 1);
    await run(p, created.target, created.registrationGeneration, 8);
  }
  report('complete', {
    runtimes: runtimes.length,
    oneAndEightReaders: true,
    realNativeFinalMatch: true,
  });
} finally {
  await p.cleanup();
}
