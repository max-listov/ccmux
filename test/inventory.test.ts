import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatEvent } from '../src/commands/events.ts';
import { peerListMachine } from '../src/commands/fleetList.ts';
import { inventoryPath } from '../src/config/paths.ts';
import type { InventoryRow, InventorySnapshot } from '../src/config/schema.ts';
import { readEvents } from '../src/events/feed.ts';
import { InventoryPublisher, inventoryRow, readInventory } from '../src/events/inventory.ts';
import type { MonitoringRow } from '../src/monitoring/schema.ts';
import type { SessionEvent } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function machine() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-inventory-'));
  dirs.push(dir);
  return makeMachine({ rcPrefix: 'host-a', stateDir: dir });
}

const UUIDS = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
} as const;

function monitoring(name: keyof typeof UUIDS, patch: Partial<MonitoringRow> = {}): MonitoringRow {
  return {
    plane: 'managed',
    name,
    agent: 'claude',
    uuid: UUIDS[name],
    rc: `rc-${name}`,
    address: `host-a:${name}`,
    dir: '/tmp',
    archived: false,
    running: false,
    state: 'stopped',
    model: null,
    contextPercent: null,
    statusLineRendersPerMinute: null,
    uptimeSeconds: null,
    lastActivityAt: null,
    turnStartedAt: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

/** One observation pass: the rows it saw, then publication. */
async function pass(
  publisher: InventoryPublisher,
  m: ReturnType<typeof machine>,
  rows: MonitoringRow[],
  publishEvents = true,
) {
  publisher.begin(m);
  for (const row of rows)
    publisher.sample(m, makeSession({ name: row.name, uuid: row.uuid }), row, 1_700_000_000);
  return publisher.publish(m, publishEvents);
}

/**
 * The consumer protocol, as a consumer implements it: apply exactly the next sequence of the
 * generation it holds, drop what it already has, re-read on anything else.
 */
function follow(
  snapshot: InventorySnapshot,
  events: SessionEvent[],
  reread: () => InventorySnapshot,
) {
  let held = { ...snapshot, sessions: new Map(snapshot.sessions.map((row) => [row.name, row])) };
  let rereads = 0;
  for (const event of events) {
    if (event.event !== 'inventory' || event.inventory === undefined) continue;
    const { generation, sequence } = event.inventory;
    if (generation === held.generation && sequence <= held.sequence) continue;
    if (generation === held.generation && sequence === held.sequence + 1) {
      if (event.row == null) held.sessions.delete(event.session);
      else held.sessions.set(event.session, event.row as InventoryRow);
      held.sequence = sequence;
      continue;
    }
    rereads += 1;
    const fresh = reread();
    held = { ...fresh, sessions: new Map(fresh.sessions.map((row) => [row.name, row])) };
  }
  return {
    generation: held.generation,
    sequence: held.sequence,
    sessions: [...held.sessions.values()],
    rereads,
  };
}

const byName = (rows: readonly InventoryRow[]) =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name));

test('clocks that move by themselves are not changes, and uptime is a start instant', () => {
  const quiet = monitoring('a', { running: true, state: 'idle', uptimeSeconds: 10 });
  const later = monitoring('a', {
    running: true,
    state: 'idle',
    uptimeSeconds: 70,
    observedAt: '2026-01-01T00:01:00.000Z',
    lastActivityAt: '2026-01-01T00:00:59.000Z',
    statusLineRendersPerMinute: 12,
    contextPercent: 40.4,
  });
  const first = inventoryRow(quiet, 1_700_000_000, null);
  const second = inventoryRow({ ...later, contextPercent: null }, 1_700_000_000, null);
  expect(second).toEqual(first);
  expect(first.startedAt).toBe('2023-11-14T22:13:20.000Z');
  expect(inventoryRow(later, 1_700_000_000, null).contextPercent).toBe(40);
  // The step carries the entry's shape, never its words.
  const step = inventoryRow(quiet, undefined, {
    kind: 'tool_call',
    role: 'assistant',
    toolName: 'Bash',
    createdAt: '2026-01-01T00:00:58.000Z',
    text: 'secret words',
  } as never).step;
  expect(step).toEqual({
    kind: 'tool_call',
    role: 'assistant',
    toolName: 'Bash',
    at: '2026-01-01T00:00:58.000Z',
  });
  expect(JSON.stringify(step)).not.toContain('secret');
});

test('each change is the next sequence of the generation, and an unchanged pass writes nothing', async () => {
  const m = machine();
  const publisher = new InventoryPublisher();
  const first = await pass(publisher, m, [monitoring('a'), monitoring('b')]);
  expect(first.sequence).toBe(2);
  const mtime = Bun.file(inventoryPath(m)).lastModified;
  await Bun.sleep(5);
  const same = await pass(publisher, m, [
    monitoring('a', { observedAt: '2026-01-01T00:05:00.000Z' }),
    monitoring('b'),
  ]);
  expect(same.sequence).toBe(2);
  expect(Bun.file(inventoryPath(m)).lastModified).toBe(mtime);
  await pass(publisher, m, [monitoring('a', { running: true, state: 'working' }), monitoring('c')]);
  const events = readEvents(m).filter((event) => event.event === 'inventory');
  expect(
    events.map((event) => [event.session, event.inventory?.sequence, event.row?.state ?? null]),
  ).toEqual([
    ['a', 1, 'stopped'],
    ['b', 2, 'stopped'],
    ['a', 3, 'working'],
    ['b', 4, null],
    ['c', 5, 'stopped'],
  ]);
  expect(events.every((event) => event.inventory?.generation === publisher.generation)).toBe(true);
  expect(readInventory(m)?.sequence).toBe(5);
});

test('a consumer holding a snapshot and the feed ends with exactly the published inventory', async () => {
  const m = machine();
  const publisher = new InventoryPublisher();
  await pass(publisher, m, [monitoring('a'), monitoring('b')]);
  const start = readInventory(m);
  if (start === null) throw new Error('no inventory published');
  const since = new Date().toISOString();
  await pass(publisher, m, [
    monitoring('a', { running: true, state: 'working', model: 'm-1' }),
    monitoring('b'),
  ]);
  await pass(publisher, m, [
    monitoring('a', { running: true, state: 'idle', model: 'm-1' }),
    monitoring('c'),
  ]);
  await pass(publisher, m, [
    monitoring('a', { running: true, state: 'idle', model: 'm-2' }),
    monitoring('c', { archived: true }),
  ]);
  // At-least-once: the boundary is read twice, as a reconnect with `--since` does.
  const events = [...readEvents(m, { since }), ...readEvents(m, { since })];
  const held = follow(start, events, () => {
    throw new Error('a consumer on an unbroken chain never re-reads');
  });
  const published = readInventory(m);
  expect(held.rereads).toBe(0);
  expect(held.sequence).toBe(published?.sequence ?? -1);
  expect(byName(held.sessions)).toEqual(byName(published?.sessions ?? []));
});

test('a new daemon generation re-announces its rows and makes a consumer re-read once', async () => {
  const m = machine();
  const old = new InventoryPublisher();
  await pass(old, m, [monitoring('a'), monitoring('b')]);
  const start = readInventory(m);
  if (start === null) throw new Error('no inventory published');
  const since = new Date().toISOString();
  const restarted = new InventoryPublisher();
  await pass(restarted, m, [monitoring('a'), monitoring('b', { running: true, state: 'idle' })]);
  // `since` can share a millisecond with the old run's last event, so the old run may be read back
  // too: at-least-once, and exactly what the consumer below must tolerate.
  const events = readEvents(m, { since });
  expect(
    events
      .filter((event) => event.inventory?.generation === restarted.generation)
      .map((event) => [event.session, event.inventory?.sequence]),
  ).toEqual([
    ['a', 1],
    ['b', 2],
  ]);
  const held = follow(start, events, () => readInventory(m) as InventorySnapshot);
  expect(held.rereads).toBe(1);
  expect(held.generation).toBe(restarted.generation);
  expect(byName(held.sessions)).toEqual(byName(readInventory(m)?.sessions ?? []));
});

test('with the feed switched off the sequence still moves, so a held snapshot is seen to be behind', async () => {
  const m = machine();
  const publisher = new InventoryPublisher();
  await pass(publisher, m, [monitoring('a')], false);
  await pass(publisher, m, [monitoring('a', { running: true, state: 'idle' })], false);
  expect(readEvents(m).filter((event) => event.event === 'inventory')).toEqual([]);
  expect(readInventory(m)?.sequence).toBe(2);
});

test('an inventory whose daemon is gone is not an inventory', () => {
  const m = machine();
  const dead = Bun.spawnSync(['true']).pid;
  writeFileSync(
    inventoryPath(m),
    JSON.stringify({ generation: UUIDS.a, sequence: 1, pid: dead, sessions: [] }),
  );
  expect(readInventory(m)).toBeNull();
  writeFileSync(
    inventoryPath(m),
    JSON.stringify({ generation: UUIDS.a, sequence: 1, pid: process.pid, sessions: [] }),
  );
  expect(readInventory(m)?.sequence).toBe(1);
});

test('a peer that publishes no inventory, or an unreadable one, costs only that field', () => {
  const answer = (inventory: unknown) =>
    peerListMachine('host-b', 'remote', {
      code: 0,
      stdout: JSON.stringify({
        version: '1.0.0',
        sessions: [],
        ...(inventory === undefined ? {} : { inventory }),
      }),
      stderr: '',
      transportFailed: false,
      delivery: 'received',
    });
  expect(answer(undefined).inventory).toBeNull();
  expect(answer({ generation: 'not-a-uuid' }).inventory).toBeNull();
  expect(answer({ generation: 'not-a-uuid' }).ok).toBe(true);
  const valid = { generation: UUIDS.b, sequence: 3, pid: 42, sessions: [] };
  expect(answer(valid).inventory).toEqual(valid);
});

test('an inventory event reads as the state it moved to', () => {
  const base = {
    v: 1,
    id: '44444444-4444-4444-8444-444444444444',
    ts: '2026-01-01T00:00:00.000Z',
    machine: 'host-a',
    session: 'a',
    agent: 'claude' as const,
    threadId: UUIDS.a,
    event: 'inventory' as const,
    inventory: { generation: UUIDS.a, sequence: 1 },
  };
  expect(
    formatEvent({
      ...base,
      row: inventoryRow(
        monitoring('a', { running: true, state: 'working', model: 'm-1' }),
        undefined,
        null,
      ),
    }),
  ).toContain('is now working · m-1');
  expect(formatEvent({ ...base, row: null })).toContain('left the inventory');
});
