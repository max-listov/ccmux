import { expect, test } from 'bun:test';
import { sharesFor } from '../scripts/testShares.ts';

test('the suite takes the cores other work leaves free, between three and eight', () => {
  // An idle eighteen-core machine: eight, the measured ceiling.
  expect(sharesFor(18, 0.5)).toBe(8);
  // Busy: what is left over.
  expect(sharesFor(18, 12)).toBe(5);
  // Saturated by other work, as when eight shares failed timing-bound tests: three.
  expect(sharesFor(18, 64)).toBe(3);
  // A small machine is not asked for more processes than it has cores.
  expect(sharesFor(2, 0)).toBe(2);
  expect(sharesFor(1, 0)).toBe(1);
});
