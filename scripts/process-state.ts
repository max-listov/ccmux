import { readFileSync } from 'node:fs';

/**
 * The state of a process, with the one distinction `kill(pid, 0)` cannot make: a ZOMBIE has already
 * exited and can never produce another effect, yet its entry stays in the table, so the signal
 * probe returns successfully and reports it as running.
 *
 * That is not a rare shape here — it is the ordinary one. Every wait in these scripts watches a
 * child of the script itself, and a script that is waiting for a child is by definition not reaping
 * it. So the probe says "still running" for exactly as long as the wait lasts, the wait ends on its
 * deadline, and acceptance fails with a message naming the correct state as unmet. The failure
 * points at the thing that worked.
 *
 * Linux answers from `/proc/<pid>/stat`; macOS has no such file and needs `ps`, which is why the
 * fallback cannot be the signal probe. A helper that fell back to `kill` was zombie-aware on one
 * platform and blind on the other, while reading as though it handled the case everywhere.
 */
/**
 * On macOS there is no `/proc`, so the state comes from `ps` — measured at 2.67ms against 0.00029ms
 * for the bare signal probe. The signal is therefore asked first, and a pid that is truly gone
 * never reaches `ps` at all.
 *
 * That ordering moves the axis, and the axis is NOT "is this path hot". It is whether the probe
 * usually finds the process ALIVE. A loop waiting for something to exit pays the full price only
 * while it has not exited — a bounded number of times — and then answers for nothing. A liveness
 * check on a process that is normally alive pays it on every single call: the monitoring read does
 * that per read, and a suite doing two hundred reads would buy half a second of `ps`.
 *
 * Where a probe is on the alive-usually side, the bare signal test stays — and then whether a
 * zombie is reachable there has to be answered rather than assumed: it is only reachable while the
 * process is a CHILD of something that is not reaping it.
 */
export function processState(pid: number): string {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = /\)\s+([A-Z])\s/.exec(stat)?.[1];
      if (!state) throw new Error(`Process ${pid} state is unreadable`);
      return state;
    }
    // Ask the signal FIRST, and only then pay for `ps`. A pid that is truly gone answers here for
    // nothing, and that is the answer a wait-for-exit loop asks for over and over — so the
    // expensive path is taken only while the process still exists, which is the bounded case.
    // ESRCH is the only "gone": EPERM means it exists and belongs to someone else.
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && String(error.code) === 'ESRCH')
        return 'absent';
    }
    // It is in the table. That is precisely when a corpse is indistinguishable from a runner, and
    // the only thing that tells them apart is the state.
    const ps = Bun.spawnSync(['ps', '-o', 'state=', '-p', String(pid)]);
    const state = ps.stdout.toString().trim().charAt(0);
    return state === '' ? 'absent' : state;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ESRCH'].includes(String(error.code))
    )
      return 'absent';
    throw error;
  }
}

/** Has it stopped for good? Gone from the table, or present only as a corpse nobody has collected. */
export function hasExited(pid: number): boolean {
  return ['absent', 'Z', 'X'].includes(processState(pid));
}
