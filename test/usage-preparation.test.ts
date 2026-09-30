import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { histFile } from '../src/agent/claude/resume.ts';
import { transcriptIndexPath } from '../src/agent/transcript/transcriptIndex.ts';
import { liveUsagePath } from '../src/usage/paths.ts';
import { UsagePreparation } from '../src/usage/preparation.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { readSessionUsage } from '../src/usage/service.ts';
import { UsageStore, usageStoreMetrics } from '../src/usage/store.ts';
import { makeMachine, makeSession } from './helpers.ts';

const record = (id: string, input: number) =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      id,
      role: 'assistant',
      model: 'model-a',
      content: [],
      usage: { input_tokens: input },
    },
  })}\n`;

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}
async function setup() {
  const root = mkdtempSync('/tmp/ccmux-usage-prepared-');
  const machine = makeMachine({
    stateDir: root,
    projectsDir: join(root, 'projects'),
    rcPrefix: 'host-a',
  });
  const session = makeSession({ name: 'agent-a', dir: root, archived: true });
  const path = histFile(root, session.uuid, machine.projectsDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, record('one', 10));
  const gate = new UsagePreparation();
  const address = 'host-a:agent-a';
  const inspect = () => gate.inspect(machine, session, address);
  const read = () =>
    readSessionUsage(machine, address, UsageQuerySchema.parse({}), true, undefined, [session]);
  const prepare = async () => {
    const work = inspect();
    const result = await read();
    work.complete(result);
    return result;
  };
  return { root, machine, session, path, gate, address, inspect, read, prepare };
}

test('prepared archive is quiet; direct requests still return totals and windows', async () => {
  await fixture(async (f) => {
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(10);
    expect(f.inspect().needed).toBe(false);
    const direct = await f.read();
    expect(direct.state).toBe('ready');
    expect(direct.self.values.inputTokens).toBe(10);
    // An explicit read may checkpoint WAL; the gate rechecks that shared index once.
    await f.prepare();
    expect(f.inspect().needed).toBe(false);
    const window = await readSessionUsage(
      f.machine,
      f.address,
      UsageQuerySchema.parse({
        since: '2026-01-01T00:00:00Z',
        until: '2026-01-02T00:00:00Z',
      }),
      true,
      undefined,
      [f.session],
    );
    expect(window.self.values.inputTokens).toBe(10);
    expect(window.sourceCoverage?.complete).toBe(true);
    expect(window.buckets).toHaveLength(1);
  });
});

test('append, late correction, same-size replacement, rotation and deleted cache rearm work', async () => {
  await fixture(async (f) => {
    await f.prepare();
    appendFileSync(f.path, record('one', 20));
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(20);
    expect(f.inspect().needed).toBe(false);
    const before = statSync(f.path);
    writeFileSync(f.path, record('one', 30) + record('one', 30));
    utimesSync(f.path, before.atime, before.mtime);
    expect(statSync(f.path).size).toBe(before.size);
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(30);
    renameSync(f.path, `${f.path}.old`);
    writeFileSync(f.path, record('two', 7));
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(7);
    rmSync(transcriptIndexPath(f.path));
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(7);
  });
});

test('source changing during preparation, failed work, config changes and restart cannot stay quiet', async () => {
  await fixture(async (f) => {
    const work = f.inspect();
    const result = await f.read();
    appendFileSync(f.path, record('two', 5));
    work.complete(result);
    expect(f.inspect().needed).toBe(true);
    await f.prepare();
    expect(f.inspect().needed).toBe(false);
    expect(new UsagePreparation().inspect(f.machine, f.session, f.address).needed).toBe(true);
    expect(
      f.gate.inspect({ ...f.machine, projectsDir: join(f.root, 'other') }, f.session, f.address)
        .needed,
    ).toBe(true);
    f.gate.retain([]);
    expect(f.inspect().needed).toBe(true);
    const failed = f.inspect();
    failed.complete({ ...result, state: 'failed' });
    expect(f.inspect().needed).toBe(true);
  });
});

test('incomplete query catch-up continues on an unchanged source', async () => {
  await fixture(async (f) => {
    writeFileSync(
      f.path,
      Array.from({ length: 1200 }, (_, i) => record(`message-${i}`, 1)).join(''),
    );
    expect((await f.prepare()).state).toBe('building');
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).state).toBe('building');
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(1200);
    expect(f.inspect().needed).toBe(false);
    appendFileSync(f.path, record('tail', 2).slice(0, -1));
    expect((await f.prepare()).state).toBe('building');
    expect(f.inspect().needed).toBe(false);
    appendFileSync(f.path, '\n');
    expect(f.inspect().needed).toBe(true);
    expect((await f.prepare()).self.values.inputTokens).toBe(1202);
  });
});

test('live ledger writes and busy SQLite rearm preparation without losing totals', async () => {
  await fixture(async (f) => {
    // Keep the immutable 4 KiB head intact while the tail grows under another writer.
    writeFileSync(
      f.path,
      Array.from({ length: 100 }, (_, i) => record(`message-${i}`, 10)).join(''),
    );
    await f.prepare();
    const live = new UsageStore(liveUsagePath(f.machine, f.session.uuid));
    try {
      live.write('test-change', 1);
      expect(f.inspect().needed).toBe(true);
      await f.prepare();
      await f.prepare();
      const work = f.inspect();
      const lock = new Database(transcriptIndexPath(f.path));
      lock.exec('BEGIN IMMEDIATE');
      try {
        appendFileSync(f.path, record('tail', 5));
        const partial = await f.read();
        expect(partial.state).toBe('building');
        expect(partial.self.values.inputTokens).toBe(1000);
        work.complete(partial);
        expect(f.inspect().needed).toBe(true);
      } finally {
        lock.exec('ROLLBACK');
        lock.close();
      }
      expect((await f.prepare()).self.values.inputTokens).toBe(1005);
      live.write('test-change', 2);
      expect(f.inspect().needed).toBe(true);
    } finally {
      live.close();
    }
  });
});

test('a failed UsageStore constructor closes its SQLite connection', () => {
  const root = mkdtempSync('/tmp/ccmux-usage-open-failure-');
  const path = join(root, 'locked.sqlite');
  const writer = new Database(path, { create: true });
  try {
    writer.exec('CREATE TABLE held (id INTEGER); BEGIN EXCLUSIVE; INSERT INTO held VALUES (1)');
    const before = usageStoreMetrics().active;
    expect(() => new UsageStore(path)).toThrow();
    expect(usageStoreMetrics().active).toBe(before);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
