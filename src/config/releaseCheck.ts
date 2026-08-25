import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { releaseCheckPath } from "./paths.ts";
import { atomicWrite } from "../util/atomic.ts";
import { compareSemver } from "../util/version.ts";
import type { MachineConfig, ReleaseStanding } from "../types.ts";

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
    return ReleaseCheckSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))).data ?? null;
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
    releasedAt: release === null ? previous?.releasedAt ?? null : release.releasedAt ?? null,
    checkedAt: nowIso,
    ok: release !== null,
  });
}

/** How far a version is behind another. Null = level with it, ahead of it, or nothing to compare. */
export type BehindBy = "patch" | "minor" | "major" | null;

/**
 * Classified once, by whoever owns the version scheme.
 *
 * Every consumer would otherwise reimplement a semver comparison and they would disagree — one
 * calling a machine two minors back "slightly behind" while another calls the same machine current.
 *
 * A machine AHEAD of the published release is not behind: that is a development checkout, and
 * painting it red would train people to ignore the colour.
 *
 * ⚠️ `latest` must be the BEST KNOWN release, not what the machine being judged happens to have
 * read. A machine that lost its route to the release feed remembers an old "latest", and measuring
 * it against its own stale memory reports it as LESS behind than it is — sometimes as up to date.
 * The error would point in the reassuring direction, in exactly the case a person is checking
 * because something looks wrong. So this takes the yardstick as an argument, and the aggregate
 * supplies it.
 */
export function behindBy(current: string, latest: string | null): BehindBy {
  if (latest === null || compareSemver(current, latest) >= 0) return null;
  const [cm = 0, cn = 0] = current.split(".").map((n) => Number.parseInt(n, 10));
  const [lm = 0, ln = 0] = latest.split(".").map((n) => Number.parseInt(n, 10));
  if (lm > cm) return "major";
  return ln > cn ? "minor" : "patch";
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
  };
}
