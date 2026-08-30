import { expect, test } from 'bun:test';
import { emptyListText, type FleetLoad, inventoryLabel } from '../src/tui/fleet.ts';
import { makeMachine } from './helpers.ts';

const load = (over: Partial<FleetLoad> = {}): FleetLoad => ({
  loaded: true,
  externalOn: true,
  externalScanning: false,
  ...over,
});

test('an empty list before the first answer says so, instead of asserting there are none', () => {
  expect(emptyListText(load({ loaded: false }), 'n to create')).toBe('loading sessions…');
  expect(emptyListText(load(), 'n to create')).toBe('no sessions — n to create');
});

test('the inventory reports off, working, and answered as three different things', () => {
  expect(inventoryLabel(load({ externalOn: false }), 0)).toBe('external off');
  expect(inventoryLabel(load({ externalScanning: true }), 0)).toBe('external scanning…');
  expect(inventoryLabel(load(), 0)).toBe('0 external');
  expect(inventoryLabel(load(), 7)).toBe('7 external');
});

test('a scan that has already found rows shows them while it keeps going', () => {
  // Mid-pass with results in hand: the count is real, so state it rather than hiding it.
  expect(inventoryLabel(load({ externalScanning: true }), 3)).toBe('3 external');
});

test('switching the inventory off is reported as off, not as an empty result', () => {
  expect(inventoryLabel(load({ externalOn: false, externalScanning: true }), 0)).toBe(
    'external off',
  );
});

test('a machine does not scan for external threads unless it says so', () => {
  expect(makeMachine().externalInventory).toBe(false);
  expect(makeMachine({ externalInventory: true }).externalInventory).toBe(true);
});
