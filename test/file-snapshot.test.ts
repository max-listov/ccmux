import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadMachineConfig, machineFileMetrics } from '../src/config/machine.ts';
import { writePendingRows } from '../src/session/pendingStore.ts';
import { writeReadyRows } from '../src/session/readyStore.ts';
import { loadSessions } from '../src/session/registry.ts';
import { FileSnapshot } from '../src/util/fileSnapshot.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('unchanged file parses once; rewrite, atomic replacement, deletion, symlink target and errors invalidate', () => {
  const root = mkdtempSync('/tmp/ccmux-file-snapshot-');
  try {
    const path = join(root, 'data');
    let parses = 0;
    const reader = new FileSnapshot<{ value: string }>();
    const load = () => {
      parses++;
      return { value: readFileSync(path, 'utf8') };
    };
    writeFileSync(path, 'one');
    reader.read(path, load).value = 'caller mutation';
    expect(reader.read(path, load).value).toBe('one');
    expect(parses).toBe(1);
    const before = statSync(path);
    writeFileSync(path, 'two');
    utimesSync(path, before.atime, before.mtime);
    expect(reader.read(path, load).value).toBe('two');
    writeFileSync(join(root, 'next'), 'tri');
    renameSync(join(root, 'next'), path);
    expect(reader.read(path, load).value).toBe('tri');
    renameSync(path, join(root, 'target'));
    symlinkSync(join(root, 'target'), path);
    reader.read(path, load);
    writeFileSync(join(root, 'target'), 'new');
    expect(reader.read(path, load).value).toBe('new');
    rmSync(path);
    expect(() => reader.read(path, load)).toThrow();
    writeFileSync(path, 'four');
    expect(reader.read(path, load).value).toBe('four');
    expect(parses).toBe(7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry notices another writer and promoted journal, and returns owned objects', async () => {
  const root = mkdtempSync('/tmp/ccmux-registry-snapshot-');
  try {
    const m = makeMachine({ stateDir: root });
    const s = makeSession();
    await writeReadyRows(m, [s]);
    loadSessions(m)[0]?.flags?.push('mutation');
    const read = loadSessions(m);
    if (!read[0]) throw new Error('missing');
    read[0].name = 'caller';
    expect(loadSessions(m)[0]?.name).toBe(s.name);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        'await Bun.write(Bun.argv[1], Bun.argv[2])',
        join(root, 'sessions.jsonl'),
        `${JSON.stringify({ ...s, name: 'other' })}\n`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await child.exited).toBe(0);
    expect(loadSessions(m)[0]?.name).toBe('other');
    await writeReadyRows(m, []);
    const { uuid, ...pendingSession } = s;
    await writePendingRows(m, [
      {
        session: pendingSession,
        generation: '11111111-1111-4111-8111-111111111112',
        marker: 'ccmux_11111111-1111-4111-8111-111111111112',
        operation: { kind: 'create' },
        createdAt: '2026-01-01T00:00:00Z',
        status: 'promoted',
        uuid,
      },
    ]);
    expect(loadSessions(m)[0]?.uuid).toBe(s.uuid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config parsing is quiet, another writer is immediately visible, env remains live and malformed replacement fails', async () => {
  const root = mkdtempSync('/tmp/ccmux-config-snapshot-');
  const path = join(root, 'machine.json');
  const original = process.env.CCMUX_CONFIG,
    prefix = process.env.CCMUX_RC_PREFIX;
  try {
    process.env.CCMUX_CONFIG = path;
    delete process.env.CCMUX_RC_PREFIX;
    const config = makeMachine({
      claudeBin: '/usr/bin/false',
      tmuxBin: '/usr/bin/false',
      codexBin: '/usr/bin/false',
      opencodeBin: '/usr/bin/false',
      rcPrefix: 'host-a',
    });
    writeFileSync(path, JSON.stringify(config));
    expect(loadMachineConfig().rcPrefix).toBe('host-a');
    const before = machineFileMetrics().loads;
    loadMachineConfig().extraFlags.push('caller');
    expect(loadMachineConfig().extraFlags).toEqual(config.extraFlags);
    expect(machineFileMetrics().loads).toBe(before);
    const writer = Bun.spawn(
      [
        process.execPath,
        '-e',
        'await Bun.write(Bun.argv[1],Bun.argv[2])',
        path,
        JSON.stringify({ ...config, ensureInterval: 99 }),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await writer.exited).toBe(0);
    expect(loadMachineConfig().ensureInterval).toBe(99);
    process.env.CCMUX_RC_PREFIX = 'host-b';
    expect(loadMachineConfig().rcPrefix).toBe('host-b');
    writeFileSync(path, '{broken');
    expect(() => loadMachineConfig()).toThrow();
    writeFileSync(path, JSON.stringify(config));
    expect(loadMachineConfig().ensureInterval).toBe(config.ensureInterval);
  } finally {
    if (original === undefined) delete process.env.CCMUX_CONFIG;
    else process.env.CCMUX_CONFIG = original;
    if (prefix === undefined) delete process.env.CCMUX_RC_PREFIX;
    else process.env.CCMUX_RC_PREFIX = prefix;
    rmSync(root, { recursive: true, force: true });
  }
});
