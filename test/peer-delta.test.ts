import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandPeerList, peerListMachine } from '../src/commands/fleetList.ts';
import {
  loadPeerHeld,
  pack,
  parseKnown,
  peerHeldDir,
  rowDigest,
  unpack,
} from '../src/fleet/peerDelta.ts';
import { packListAnswer as deltaListJson } from '../src/fleet/peerRead.ts';
import type { RemoteResult } from '../src/fleet/transport.ts';
import type { ListJson } from '../src/types.ts';

const UUID = '22222222-2222-4222-8222-222222222222';

function session(name: string, seconds: number, step = 'idle') {
  return {
    name,
    agent: 'claude',
    state: 'running',
    running: true,
    archived: false,
    lastMessage: { text: `${step} ${'x'.repeat(2_000)}` },
    uptime: { text: `${Math.floor(seconds / 60)}m`, seconds },
  };
}

function answer(seconds: number, step = 'idle'): ListJson {
  return {
    version: '1.0.0',
    generatedAt: new Date(seconds * 1000).toISOString(),
    rcPrefix: 'host-b',
    stateDir: '~/.local/state/ccmux',
    release: null,
    sessions: ['agent-a', 'agent-b', 'agent-c'].map((name, index) =>
      session(name, seconds + index, name === 'agent-b' ? step : 'idle'),
    ),
    inventory: {
      generation: UUID,
      sequence: 1,
      pid: 42,
      sessions: [{ name: 'agent-a', step: { at: step } }],
    },
  } as unknown as ListJson;
}

const received = (stdout: string): RemoteResult => ({
  code: 0,
  stdout,
  stderr: '',
  transportFailed: false,
  delivery: 'received',
});

test('a packed array comes back whole, and a held row travels as its digest', () => {
  const rows = [{ a: 1 }, { a: 2 }, { a: 1 }];
  const first = pack(rows, new Set());
  expect(unpack(first, {})).toEqual(rows);
  const second = pack(rows, new Set(first.refs));
  expect(second.items).toEqual({});
  expect(unpack(second, first.items)).toEqual(rows);
  expect(parseKnown(first.refs.join(','))).toEqual(new Set(first.refs));
});

test('an answer naming a row the reader never held is refused, not filled in', () => {
  const packed = pack([{ a: 1 }], new Set([rowDigest({ a: 1 })]));
  expect(unpack(packed, {})).toBeNull();
  expect(expandPeerList(deltaListJson(answer(100), new Set(packed.refs)), {})).not.toBeNull();
  const lying = JSON.parse(JSON.stringify(deltaListJson(answer(100), new Set())));
  lying.sessions.items = {};
  expect(expandPeerList(lying, {})).toBeNull();
  expect(peerListMachine('host-b', 'remote', received(JSON.stringify(lying)))).toMatchObject({
    ok: false,
    error: 'unreadable list output (older ccmux?)',
  });
});

test('a peer read while nothing happens carries digests and uptimes, not rows', () => {
  const first = deltaListJson(answer(100), new Set()) as {
    sessions: { refs: string[]; items: Record<string, unknown> };
    inventory: { sessions: { refs: string[]; items: Record<string, unknown> } };
  };
  const held = { ...first.sessions.items, ...first.inventory.sessions.items };
  const known = new Set(Object.keys(held));
  // Five seconds later every uptime has moved and nothing else has.
  const later = answer(105);
  const quiet = JSON.stringify(deltaListJson(later, known));
  expect(JSON.parse(quiet).sessions.items).toEqual({});
  expect(JSON.parse(quiet).inventory.sessions.items).toEqual({});
  expect(Buffer.byteLength(quiet)).toBeLessThan(Buffer.byteLength(JSON.stringify(later)) / 5);
  // And what the reader rebuilds is the answer the peer stood for, uptimes included.
  expect(expandPeerList(JSON.parse(quiet), held)?.answer).toEqual(
    JSON.parse(JSON.stringify(later)),
  );

  // One session takes a step: that row, and only that row, travels.
  const step = JSON.parse(JSON.stringify(deltaListJson(answer(106, 'working'), known)));
  expect(Object.keys(step.sessions.items)).toHaveLength(1);
  expect(Object.values(step.sessions.items)[0]).toMatchObject({ name: 'agent-b' });
});

test('the fleet reader keeps exactly the rows of its latest answer between reads', () => {
  const held = loadPeerHeld('host-b', 'list');
  expect(held.knownArgs).toEqual([]);
  const first = peerListMachine(
    'host-b',
    'remote',
    received(JSON.stringify(deltaListJson(answer(100), new Set()))),
    held,
  );
  expect(first).toMatchObject({ ok: true, version: '1.0.0' });
  expect(first.sessions.map((s) => s.uptime.seconds)).toEqual([100, 101, 102]);
  expect(existsSync(join(peerHeldDir(), 'host-b.list.json'))).toBe(true);

  const again = loadPeerHeld('host-b', 'list');
  expect(again.knownArgs[0]).toBe('--known');
  const known = parseKnown(again.knownArgs[1]);
  expect(known.size).toBe(4);
  const stepped = peerListMachine(
    'host-b',
    'remote',
    received(JSON.stringify(deltaListJson(answer(110, 'working'), known))),
    again,
  );
  expect(stepped.sessions.map((s) => s.uptime.seconds)).toEqual([110, 111, 112]);
  expect(stepped.sessions[1]?.lastMessage?.text?.startsWith('working')).toBe(true);
  // The row the step replaced is dropped; the reader never accumulates history.
  expect(parseKnown(loadPeerHeld('host-b', 'list').knownArgs[1]).size).toBe(4);
});
