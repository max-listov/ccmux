import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { MachineConfig, ReleaseStanding } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { compareSemver } from '../util/version.ts';
import { releaseCheckPath } from './paths.ts';

/**
 * What this machine last learned about the newest published release.
 *
 * The supervisor already asks. `autoUpdateOnce` fetches the release manifest on every tick, compares
 * it, acts on it — and then throws the answer away, so the one place in the system that looks at
 * "what should be running" from the machine itself was also the only place that never told anyone.
 * A fleet view could therefore show which version each machine runs and nothing about whether that
 * is the right one; the other half came from a person reading GitHub and comparing by eye.
 *
 * Two distinctions carry this record, and both exist because collapsing them produces a confident
 * lie in exactly the case the check matters:
 *
 *  - **"up to date" is not "we do not know."** A machine with no `releaseUrl`, or one that has never
 *    completed a check, has no opinion about the newest release. Drawn as current, it would look
 *    healthiest precisely when nothing has verified it.
 *  - **What we last LEARNED is not when we last ASKED.** A machine that cannot reach the release
 *    feed still remembers what it knew an hour ago, and that memory is worth keeping — but it must
 *    arrive stamped with a failed attempt, so a reader dims it instead of trusting it.
 */

const ReleaseCheckSchema = z.object({
  /** Newest version successfully read, retained across later failures. Null = never read one. */
  version: z.string().nullable(),
  /** When that release was published, when the manifest said so. Null on an older manifest. */
  releasedAt: z.string().nullable().default(null),
  /** When a check was last ATTEMPTED — success or failure. */
  checkedAt: z.string(),
  /** Did that last attempt succeed? */
  ok: z.boolean(),
});
export type ReleaseCheck = z.infer<typeof ReleaseCheckSchema>;

export function readReleaseCheck(m: MachineConfig): ReleaseCheck | null {
  try {
    const path = releaseCheckPath(m);
    if (!existsSync(path)) return null;
    return ReleaseCheckSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).data ?? null;
  } catch {
    return null;
  }
}

/** Best-effort, like every other note the supervisor keeps about itself: a check that could not be
 *  written down must never cost the update pass it belongs to. */
export async function writeReleaseCheck(m: MachineConfig, next: ReleaseCheck): Promise<void> {
  try {
    await atomicWrite(releaseCheckPath(m), JSON.stringify(next));
  } catch {
    // the next tick tries again
  }
}

/** Record an attempt, keeping what was last learned when this one failed. */
export async function recordReleaseCheck(
  m: MachineConfig,
  release: { version: string; releasedAt?: string | undefined } | null,
  nowIso: string,
): Promise<void> {
  const previous = readReleaseCheck(m);
  await writeReleaseCheck(m, {
    version: release?.version ?? previous?.version ?? null,
    releasedAt: release === null ? (previous?.releasedAt ?? null) : (release.releasedAt ?? null),
    checkedAt: nowIso,
    ok: release !== null,
  });
}

/** How far a version is behind another. Null = level with it, ahead of it, or nothing to compare. */
export type BehindBy = 'patch' | 'minor' | 'major' | null;

const parts = (v: string): [number, number, number] => {
  const [a = 0, b = 0, c = 0] = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [a, b, c];
};

/**
 * Classified once, by whoever owns the version scheme.
 *
 * Every consumer would otherwise reimplement a semver comparison and they would disagree — one
 * calling a machine two minors back "slightly behind" while another calls the same machine current.
 *
 * **The breaking axis is the leftmost position that is not zero.** Below 1.0.0 that is the MINOR
 * position, which is what `^0.23.0` encodes and what every project in this family lives under.
 * Reading the positions literally instead makes `major` unreachable for the entire pre-1.0 life of a
 * project and files every breaking jump under `minor` — 0.23 against 0.63 is forty breaking releases
 * reported as a moderate one. The error points in the reassuring direction, which is the direction
 * that costs: a dashboard colours by this word, and the reader acts on the colour.
 *
 * A machine AHEAD of the published release is not behind: that is a development checkout, and
 * painting it red would train people to ignore the colour.
 */
export function behindBy(current: string, latest: string | null): BehindBy {
  if (latest === null || compareSemver(current, latest) >= 0) return null;
  const c = parts(current);
  const l = parts(latest);
  const axis = l[0] > 0 ? 0 : l[1] > 0 ? 1 : 2;
  const firstDiff = c[0] !== l[0] ? 0 : c[1] !== l[1] ? 1 : 2;
  if (firstDiff <= axis) return 'major'; // a difference at or above the breaking axis IS breaking
  // Only a scheme with a real major has a middle class; below 1.0.0 there is breaking and there is
  // compatible, and calling a compatible bump "minor" would overstate it in the other direction.
  return firstDiff === 1 && axis === 0 ? 'minor' : 'patch';
}

/** The best release any of these machines has managed to read. Null when none of them knows. */
export function bestKnownRelease(seen: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of seen) {
    if (v === null) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** The release standing of this machine, as the JSON contract reports it. The shape lives in the
 *  schema, like every other wire shape — there is one definition, not two that can drift. */
export function releaseStanding(m: MachineConfig, current: string): ReleaseStanding {
  const check = readReleaseCheck(m);
  return {
    current,
    latest: check?.version ?? null,
    latestAt: check?.releasedAt ?? null,
    checkedAt: check?.checkedAt ?? null,
    // No check at all is not a failed check — it is a machine that has never been asked to look
    // (no `releaseUrl`). `latest: null` is what says "we do not know"; this field is about the
    // health of the asking.
    ok: check?.ok ?? true,
    // A fourth state, and the one that hid a supervisor being dead for two hours: the last check
    // SUCCEEDED, so `ok` is true and `latest` is a real version — and nothing has asked since,
    // because the process whose job that is stopped running. The machine then reads as "a patch
    // behind", which is mild and self-correcting, when it is neither. Only this machine knows how
    // often it is supposed to look, so only this machine can say the looking has stopped.
    checksOverdue: checksOverdue(m, check),
  };
}

/**
 * Four missed rounds, not one. A tick can be late for reasons that fix themselves — a slow fetch, a
 * busy host, a restart mid-interval — and a marker that fires on those teaches people to ignore it,
 * which costs more than the marker is worth. Four is comfortably past any of them and still well
 * inside the window where a stopped supervisor matters.
 *
 * A machine that never checks on purpose (`autoUpdate` off) is not overdue, and neither is one that
 * has never checked at all: that is `latest: null` already saying "we do not know", and saying it
 * twice in different words helps nobody.
 */
const OVERDUE_ROUNDS = 4;

function checksOverdue(m: MachineConfig, check: ReleaseCheck | null): boolean {
  if (!m.autoUpdate || check === null) return false;
  const last = Date.parse(check.checkedAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last > m.updateCheckInterval * 1000 * OVERDUE_ROUNDS;
}
