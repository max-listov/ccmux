import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { type FleetMachine, fleetView, machineStanding } from '../src/commands/fleetList.ts';
import {
  behindBy,
  bestKnownRelease,
  releaseStanding,
  writeReleaseCheck,
} from '../src/config/releaseCheck.ts';
import { makeMachine } from './helpers.ts';

// A fleet view could show which version each machine RUNS and nothing about whether that is the
// right one — the other half came from a person reading the releases page and comparing by eye.
// Two states must stay apart while closing that gap: "up to date" and "nobody has been able to
// check". Collapsing them draws a machine as healthiest exactly when nothing has verified it.

const machine = (
  name: string,
  current: string,
  latest: string | null,
  ok = true,
): FleetMachine => ({
  machine: name,
  alias: null,
  ok: true,
  error: null,
  version: current,
  release: {
    current,
    latest,
    latestAt: null,
    checkedAt: '2026-08-25T10:00:00.000Z',
    ok,
    checksOverdue: false,
  },
  behind: null,
  sessions: [],
});

test('behind is classified, not left to each reader to reinvent', () => {
  expect(behindBy('1.2.0', '2.0.0')).toBe('major');
  expect(behindBy('1.2.0', '1.3.0')).toBe('minor');
  expect(behindBy('1.2.0', '1.2.3')).toBe('patch');
  expect(behindBy('0.35.0', '0.35.0')).toBeNull();
});

test('below 1.0.0 the MINOR position is the breaking one, and is reported as such', () => {
  // Reading the positions literally makes `major` unreachable for the entire pre-1.0 life of a
  // project and files every breaking jump under `minor`: 0.23 against 0.63 is forty breaking
  // releases reported as a moderate one. The error points in the reassuring direction, which is the
  // direction that costs — a dashboard colours by this word and the reader acts on the colour.
  expect(behindBy('0.34.0', '0.35.0')).toBe('major');
  expect(behindBy('0.23.0', '0.63.0')).toBe('major');
  // …and a compatible bump stays compatible. Calling it "minor" would overstate it the other way:
  // below 1.0.0 there is breaking and there is compatible, and no middle class exists to name.
  expect(behindBy('0.35.0', '0.35.1')).toBe('patch');
});

test('the axis is the leftmost NON-ZERO position, so 0.0.x is breaking on every bump', () => {
  // What `^0.0.3` encodes: nothing else is allowed. The rule generalises rather than special-casing
  // one shape of version.
  expect(behindBy('0.0.3', '0.0.4')).toBe('major');
});

test('a machine AHEAD of the release is not behind', () => {
  // A development checkout. Painting it red would train people to ignore the colour.
  expect(behindBy('0.36.0', '0.35.0')).toBeNull();
});

test('with nothing to measure against, no claim is made', () => {
  expect(behindBy('0.35.0', null)).toBeNull();
  expect(bestKnownRelease([null, null])).toBeNull();
});

test('the yardstick is the BEST release anyone knows, not what each machine remembers', () => {
  expect(bestKnownRelease(['0.30.0', null, '0.35.0', '0.34.0'])).toBe('0.35.0');
});

test('a machine that lost the release feed is judged by the fleet, not by its own memory', () => {
  // The defect this shape exists to prevent, and the reason `behind` is not a machine's own claim.
  // A disconnected box remembers an old "latest"; measured against that memory it reports itself as
  // LESS behind than it is — here, as perfectly up to date. The error points in the reassuring
  // direction, in exactly the case someone is checking because something looks wrong.
  const view = fleetView([
    machine('host-a', '0.35.0', '0.35.0'),
    machine('host-b', '0.30.0', '0.30.0', false),
  ]);
  expect(view.latest).toBe('0.35.0');
  expect(view.machines[0]?.behind).toBeNull();
  expect(view.machines[1]?.behind).toBe('major'); // NOT null, which its own memory would have said
});

test('its own stale memory is still reported — that is WHY it is behind', () => {
  const view = fleetView([
    machine('host-a', '0.35.0', '0.35.0'),
    machine('host-b', '0.30.0', '0.30.0', false),
  ]);
  expect(view.machines[1]?.release?.latest).toBe('0.30.0');
  expect(view.machines[1]?.release?.ok).toBe(false);
});

test('a machine nobody could reach makes no claim about its release', () => {
  const unreachable: FleetMachine = {
    machine: 'host-c',
    alias: 'remote',
    ok: false,
    error: 'no transit',
    version: '?',
    release: null,
    behind: null,
    sessions: [],
  };
  const view = fleetView([machine('host-a', '0.35.0', '0.35.0'), unreachable]);
  expect(view.machines[1]?.behind).toBeNull();
  expect(view.machines[1]?.release).toBeNull();
});

test('when NO machine knows a release, nobody is drawn as behind', () => {
  // Not knowing is not a verdict. Every machine here is simply unmeasured.
  const view = fleetView([machine('host-a', '0.35.0', null), machine('host-b', '0.30.0', null)]);
  expect(view.latest).toBeNull();
  expect(view.machines.every((x) => x.behind === null)).toBe(true);
});

test('the publication date rides along, so lag can be read in time rather than in components', () => {
  const withDate: FleetMachine = {
    ...machine('host-a', '0.35.0', '0.35.0'),
    release: {
      current: '0.35.0',
      latest: '0.35.0',
      latestAt: '2026-08-25T14:42:18Z',
      checkedAt: 'x',
      ok: true,
      checksOverdue: false,
    },
  };
  expect(fleetView([withDate, machine('host-b', '0.30.0', '0.30.0', false)]).latestAt).toBe(
    '2026-08-25T14:42:18Z',
  );
});

test('a check that stopped happening is not the same as one that came back behind', async () => {
  const stateDir = mkdtempSync('/tmp/ccmux-overdue-');
  const m = makeMachine({ stateDir, autoUpdate: true, updateCheckInterval: 300 });
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  // Never checked: `latest: null` already says "we do not know". Saying it twice helps nobody.
  expect(releaseStanding(m, '0.47.0').checksOverdue).toBe(false);

  // A check that happened a moment ago, and one that is merely late. Neither is news: a tick can
  // slip for reasons that fix themselves, and a marker firing on those trains people to ignore it.
  await writeReleaseCheck(m, { version: '0.47.9', releasedAt: null, checkedAt: ago(30), ok: true });
  expect(releaseStanding(m, '0.47.0').checksOverdue).toBe(false);
  await writeReleaseCheck(m, {
    version: '0.47.9',
    releasedAt: null,
    checkedAt: ago(900),
    ok: true,
  });
  expect(releaseStanding(m, '0.47.0').checksOverdue).toBe(false);

  // Four rounds past due, and the last attempt SUCCEEDED — which is exactly the case that used to
  // read as healthy. `ok` and `latest` say the last look worked; nothing says the looking stopped.
  await writeReleaseCheck(m, {
    version: '0.47.9',
    releasedAt: null,
    checkedAt: ago(7_200),
    ok: true,
  });
  const stopped = releaseStanding(m, '0.47.0');
  expect(stopped.checksOverdue).toBe(true);
  expect(stopped.ok).toBe(true);
  expect(stopped.latest).toBe('0.47.9');

  // A machine that never checks on purpose is not a machine whose checking died.
  const manual = makeMachine({ stateDir, autoUpdate: false, updateCheckInterval: 300 });
  expect(releaseStanding(manual, '0.47.0').checksOverdue).toBe(false);
});

test('a machine that stopped checking says so instead of looking mildly behind', () => {
  const behind = machine('host-a', '0.47.0', '0.47.9');
  const view = fleetView([behind]);
  const row = view.machines[0];
  if (row === undefined) throw new Error('fixture produced no machine');
  expect(machineStanding(row)).toContain('behind');

  // Same version gap, same successful last check — and the supervisor is gone. The mild reading
  // must not win here: it is the one that let a fleet run unsupervised without saying anything.
  const stopped = fleetView([
    {
      ...behind,
      release: { ...(behind.release ?? null), checksOverdue: true } as NonNullable<
        FleetMachine['release']
      >,
    },
  ]).machines[0];
  if (stopped === undefined) throw new Error('fixture produced no machine');
  expect(stopped.behind).not.toBeNull();
  expect(machineStanding(stopped)).toContain('nothing has checked since');
  expect(machineStanding(stopped)).not.toContain('behind');
});
