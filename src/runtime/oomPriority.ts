import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProcStat } from '../chat/auth.ts';

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

interface ProcRow {
  pid: number;
  parent: number;
}

/** The process table as parent links, from `/proc` — one file read per process, nothing spawned. */
export function readProcTable(procRoot = '/proc'): { rows: ProcRow[]; runners: number[] } {
  const rows: ProcRow[] = [];
  const runners: number[] = [];
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return { rows, runners };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let entry: ReturnType<typeof parseProcStat>;
    try {
      entry = parseProcStat(readFileSync(join(procRoot, name, 'stat'), 'utf8'));
    } catch {
      continue; // gone between the listing and the read
    }
    if (entry === null) continue;
    rows.push({ pid, parent: entry.parent });
    // A pane's `_run` is an interpreter running this program; only those pay a second read.
    if (entry.command === 'bun' && isRunner(readArgv(procRoot, pid))) runners.push(pid);
  }
  return { rows, runners };
}

function readArgv(procRoot: string, pid: number): string[] {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter((arg) => arg !== '');
  } catch {
    return [];
  }
}

/** `bun … ccmux.js _run <name>` (or the source entry in a dev checkout). */
export function isRunner(argv: readonly string[]): boolean {
  const run = argv.indexOf('_run');
  return run > 0 && argv.slice(0, run).some((arg) => /(?:ccmux\.js|cli\.ts)$/.test(arg));
}

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

export function procOomAccess(procRoot = '/proc'): OomAccess {
  return {
    read(pid) {
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
      writeFileSync(join(procRoot, String(pid), 'oom_score_adj'), String(value));
    },
  };
}

/** A write the kernel refused for lack of privilege, as opposed to a process that just exited. */
export function isPermissionRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
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
