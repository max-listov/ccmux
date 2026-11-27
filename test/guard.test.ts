import { expect, test } from 'bun:test';
import { refusesSelf } from '../src/commands/guard.ts';

test('blocks rm/stop of the calling session, allows others + --force override', () => {
  const prev = process.env.STITCHMUX_SESSION;
  process.env.STITCHMUX_SESSION = 'cc-self';
  try {
    expect(refusesSelf('rm', 'cc-self', false)).toBe(true); // self → blocked
    expect(refusesSelf('stop', 'cc-self', true)).toBe(false); // --force overrides
    expect(refusesSelf('rm', 'cc-other', false)).toBe(false); // other session allowed
  } finally {
    if (prev === undefined) delete process.env.STITCHMUX_SESSION;
    else process.env.STITCHMUX_SESSION = prev;
  }
});

test('no-op outside a session (daemon/CLI have no STITCHMUX_SESSION)', () => {
  const prev = process.env.STITCHMUX_SESSION;
  delete process.env.STITCHMUX_SESSION;
  try {
    expect(refusesSelf('rm', 'cc-anything', false)).toBe(false);
  } finally {
    if (prev !== undefined) process.env.STITCHMUX_SESSION = prev;
  }
});
