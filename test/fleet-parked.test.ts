import { expect, test } from 'bun:test';
import { z } from 'zod';
import { type FleetMachine, fleetView, partitionParked } from '../src/commands/fleetList.ts';
import { rowStateLabel } from '../src/commands/list.ts';

// Measured 2026-08-31: of 96 rows the fleet map printed, 61 were sessions somebody had deliberately
// archived — and every one of them read as `stopped`, which is what a live session that is down
// looks like. The map said "sixty-one things need attention" about sixty-one things that did not.

test('a parked session reads as parked, not as one that fell over', () => {
  expect(rowStateLabel('stopped', false, true)).toBe('archived');
  expect(rowStateLabel('stopped', false, false)).toBe('stopped');
});

test('an archived session that is somehow running reports what it is doing', () => {
  // The run-state is the more truthful signal then: "archived" would describe the intent while the
  // session is actually taking turns, and the intent is not what a reader needs at that moment.
  expect(rowStateLabel('working', true, true)).toBe('working');
  expect(rowStateLabel('idle', true, true)).toBe('idle');
});

test('parked rows are counted rather than dropped, and --all brings them back', () => {
  const rows = [
    { name: 'live-a', archived: false },
    { name: 'parked-a', archived: true },
    { name: 'parked-b', archived: true },
  ];
  const folded = partitionParked(rows, false);
  expect(folded.shown.map((r) => r.name)).toEqual(['live-a']);
  expect(folded.parked).toBe(2);
  const everything = partitionParked(rows, true);
  expect(everything.shown).toHaveLength(3);
  // Nothing is "hidden" in the sense that matters: asking for all of it returns all of it, and not
  // asking still says how many are there.
  expect(everything.parked).toBe(0);
});

test('a machine with nothing parked says nothing about parking', () => {
  const { shown, parked } = partitionParked([{ name: 'a', archived: false }], false);
  expect(shown).toHaveLength(1);
  expect(parked).toBe(0);
});

test("a peer's parked rows are read by the same rule as this machine's", () => {
  // The two halves of the map used to disagree: `ccmux list` said `archived` for a row while
  // `ccmux fleet` said `stopped` for that same row on that same machine.
  const machine: FleetMachine = {
    machine: 'host-a',
    alias: null,
    ok: true,
    error: null,
    version: '0.39.40',
    release: null,
    behind: null,
    sessions: [
      {
        name: 'parked',
        agent: 'codex',
        state: rowStateLabel('stopped', false, true),
        archived: true,
        model: null,
        running: false,
        stale: [],
        dir: null,
        role: null,
        turnStartedAt: null,
        waitingFor: null,
        context: {
          text: null,
          usedTokens: null,
          limitTokens: null,
          percent: null,
          rawLimitTokens: null,
          window: null,
        },
        account: null,
        costUsd: null,
      },
    ],
  };
  const view = fleetView([machine]);
  expect(view.machines[0]?.sessions[0]?.state).toBe('archived');
});

test('a peer that never mentions archiving is read exactly as before', () => {
  // An older peer omits the field. `false` is not a guess about that machine — it reproduces the
  // reading those rows already had, which is the only honest default for a fact not sent.
  const Remote = z.object({ name: z.string(), archived: z.boolean().default(false) });
  const parsed = Remote.parse({ name: 'agent-a' });
  expect(parsed.archived).toBe(false);
  expect(rowStateLabel('idle', true, parsed.archived)).toBe('idle');
});
