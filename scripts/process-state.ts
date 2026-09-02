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
export function processState(pid: number): string {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = /\)\s+([A-Z])\s/.exec(stat)?.[1];
      if (!state) throw new Error(`Process ${pid} state is unreadable`);
      return state;
    }
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
