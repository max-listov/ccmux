import { existsSync, readFileSync } from 'node:fs';
import { observeProcessInstance, ProcessInstanceSchema } from 'stitchkit/process';
import { z } from 'zod';
import type { Session } from '../types.ts';

/**
 * The process boundary of one session: which processes are its own, so a build or test an agent
 * starts can be told apart from the other sessions' and named after the session that started it.
 *
 * On Linux every session runs in its own transient systemd scope, `stitchmux-session-<uuid>-<start>.scope`:
 * a cgroup survives a daemonised grandchild, which a parent chain does not. On macOS there is no
 * such unit; the boundary is the session's root processes, each with the instance that tells it from
 * a reused PID.
 *
 * Temporary until Stitchkit's launch-in-boundary primitive
 * (`max-listov/stitchkit-dev:2026-11-27-launch-work-in-its-own-boundary-and-declare-its-owner.md`).
 */
export const SessionBoundarySchema = z
  .object({
    /** The cgroup unit holding the session's processes on Linux; null where there is none. */
    unit: z.string().min(1).max(256).nullable(),
    roots: z
      .array(
        z.object({ pid: z.number().int().positive(), instance: ProcessInstanceSchema.nullable() }),
      )
      // A session has a pane and at most a native owner and provider; the cap keeps a monitoring
      // row inside the snapshot's byte budget.
      .max(4),
  })
  .strict();
export type SessionBoundary = z.infer<typeof SessionBoundarySchema>;

const SCOPE_PREFIX = 'stitchmux-session-';

/**
 * How systemd can give this process a scope, or null when it cannot: not Linux, no systemd as PID 1,
 * no `systemd-run`, or a scope that systemd refuses to create here (a CI runner without a user
 * manager). Decided once per process by creating a real scope around `true`, so a session is never
 * launched through a wrapper that would fail before its command runs.
 */
let probed: string[] | null | undefined;
export function systemdScopeArgs(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
  which: (bin: string) => string | null = Bun.which,
  exists: (path: string) => boolean = existsSync,
  works: (args: string[]) => boolean = (args) =>
    Bun.spawnSync([...args, '--scope', '--quiet', '--collect', '--', 'true'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 5_000,
    }).exitCode === 0,
): string[] | null {
  if (probed !== undefined) return probed;
  probed = null;
  if (platform !== 'linux' || !exists('/run/systemd/system')) return probed;
  const bin = which('systemd-run');
  if (bin === null) return probed;
  const args = uid === 0 ? [bin] : [bin, '--user'];
  if (works(args)) probed = args;
  return probed;
}

/** Forget the probe; for tests that decide the platform themselves. */
export function resetSystemdScopeProbe(): void {
  probed = undefined;
}

/**
 * `cmd` started in the session's own scope where systemd offers one, otherwise unchanged. The unit
 * name carries the session's uuid and the start time, so a restart never collides with a scope of
 * the previous run that is still draining.
 */
export function launchInBoundary(
  s: Pick<Session, 'uuid'>,
  cmd: readonly string[],
  scope: string[] | null = systemdScopeArgs(),
  now = Date.now(),
): string[] {
  if (scope === null) return [...cmd];
  return [
    ...scope,
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${SCOPE_PREFIX}${s.uuid}-${now.toString(36)}`,
    '--',
    ...cmd,
  ];
}

/** The unit a Linux process's cgroup names (`….scope`/`….service`), or null. */
export function cgroupUnitOf(
  pid: number,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | null {
  let text: string;
  try {
    text = read(`/proc/${pid}/cgroup`);
  } catch {
    return null;
  }
  // cgroup v2 is one `0::/path` line; v1 lists controllers, and the systemd one names the unit.
  for (const line of text.split('\n')) {
    const path = line.split(':').slice(2).join(':');
    const unit = path.split('/').filter(Boolean).at(-1);
    if (unit !== undefined && /\.(scope|service)$/.test(unit)) return unit;
  }
  return null;
}

/** Observe the boundary of a session whose root processes are `roots`. */
export async function observeSessionBoundary(
  roots: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Promise<SessionBoundary | null> {
  if (roots.length === 0) return null;
  const observed = await Promise.all(
    roots.slice(0, 4).map(async (pid) => {
      const reading = await observeProcessInstance(pid);
      return { pid, instance: reading.state === 'observed' ? reading.instance : null };
    }),
  );
  const unit =
    platform === 'linux'
      ? (roots.map((pid) => cgroupUnitOf(pid)).find((name) => name !== null) ?? null)
      : null;
  return { unit, roots: observed };
}
