import { closeSync, constants, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessStart } from '../util/procStat.ts';
import type { ProcRow } from './procTable.ts';

/**
 * Who the kernel kills first when a shared memory cgroup runs out.
 *
 * Every session lives in one cgroup with whatever it starts — dev servers, browsers, builds — and
 * the OOM killer picks by size and `oom_score_adj`. A headless browser sets itself to 200–300 and
 * dies first, which is right; the agent, its pane and the tmux server stood at 0, so once the
 * browsers were gone the next victim was a session in the middle of a turn.
 *
 * So the supervising spine is lowered — this daemon, the tmux server holding the panes, each pane's
 * `_run`, and the agent that `_run` started — and nothing below it is. The value is inherited at
 * fork, so an agent's tools, browsers and builds start at the agent's value; the pass that lowers
 * the spine therefore also returns every descendant that merely inherited it to 0. Only a
 * descendant still at exactly the spine's value is touched: one that raised itself (a browser at
 * 300) or was set on purpose keeps what it has.
 *
 * Linux only. Lowering the value needs CAP_SYS_RESOURCE; a machine without it is told once and the
 * mechanism stays off there.
 */

/**
 * Which processes the pass lowers, and which it may return to 0.
 *
 * The spine is this daemon, each pane `_run`, the tmux server that is its parent and the agent that
 * is its child. Everything below an agent or below this daemon that is not itself spine is a
 * release candidate.
 */
export function oomPlan(
  table: { rows: ProcRow[]; runners: number[] },
  selfPid: number,
): { spine: number[]; below: number[] } {
  const children = new Map<number, number[]>();
  const parentOf = new Map<number, number>();
  for (const row of table.rows) {
    parentOf.set(row.pid, row.parent);
    const list = children.get(row.parent) ?? [];
    list.push(row.pid);
    children.set(row.parent, list);
  }
  const spine = new Set<number>([selfPid]);
  const agents: number[] = [];
  for (const runner of table.runners) {
    spine.add(runner);
    const server = parentOf.get(runner);
    if (server !== undefined && server > 1) spine.add(server);
    for (const agent of children.get(runner) ?? []) {
      spine.add(agent);
      agents.push(agent);
    }
  }
  const below = new Set<number>();
  const walk = (from: number): void => {
    for (const child of children.get(from) ?? []) {
      if (below.has(child)) continue;
      if (!spine.has(child)) below.add(child);
      walk(child);
    }
  };
  for (const root of [selfPid, ...agents]) walk(root);
  return { spine: [...spine], below: [...below] };
}

export interface OomAccess {
  read(pid: number): number | null;
  write(pid: number, value: number): void;
}

export function procOomAccess(rows: ProcRow[], procRoot = '/proc'): OomAccess {
  const epochs = new Map(rows.map((row) => [row.pid, row.startTime]));
  const sameProcess = (pid: number): boolean => {
    const expected = epochs.get(pid);
    if (expected === undefined) return false;
    return readProcessStart(pid, procRoot) === expected;
  };
  return {
    read(pid) {
      if (!sameProcess(pid)) return null;
      try {
        const value = Number.parseInt(
          readFileSync(join(procRoot, String(pid), 'oom_score_adj'), 'utf8'),
          10,
        );
        return Number.isInteger(value) ? value : null;
      } catch {
        return null;
      }
    },
    write(pid, value) {
      // An open procfs fd belongs to that process even when its numeric PID is subsequently reused.
      const fd = openSync(join(procRoot, String(pid), 'oom_score_adj'), constants.O_WRONLY);
      try {
        if (!sameProcess(pid))
          throw Object.assign(new Error('Process identity changed'), { code: 'ESRCH' });
        writeSync(fd, String(value));
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** A write the kernel refused for lack of privilege, as opposed to a process that just exited. */
export function isPermissionRefusal(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * One pass: lower the spine to `target` where it stands higher, return an inherited `target` below
 * it to 0. Throws only a permission refusal; a process that exited mid-pass is skipped.
 */
export function applyOomPriority(
  plan: { spine: number[]; below: number[] },
  target: number,
  access: OomAccess,
): { lowered: number; released: number } {
  let lowered = 0;
  let released = 0;
  const set = (pid: number, value: number): boolean => {
    try {
      access.write(pid, value);
      return true;
    } catch (error) {
      if (isPermissionRefusal(error)) throw error;
      return false;
    }
  };
  for (const pid of plan.spine) {
    const current = access.read(pid);
    if (current !== null && current > target && set(pid, target)) lowered++;
  }
  for (const pid of plan.below) {
    if (access.read(pid) === target && set(pid, 0)) released++;
  }
  return { lowered, released };
}
