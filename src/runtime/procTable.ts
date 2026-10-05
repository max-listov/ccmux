import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measured } from '../util/cpuScope.ts';
import { parseProcessStat } from '../util/procStat.ts';

export interface ProcRow {
  pid: number;
  parent: number;
  startTime?: string;
}
type Process = ProcRow & { command: string; threads: number };
const estimates = new Map<string, number>();

function readProcess(procRoot: string, pid: number): Process | null {
  try {
    const entry = parseProcessStat(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'));
    if (!entry) return null;
    return {
      pid,
      parent: entry.parent,
      command: entry.command,
      threads: entry.threads,
      ...(entry.startTime ? { startTime: entry.startTime } : {}),
    };
  } catch {
    return null;
  }
}

/** Sparse trees use task children; thread-heavy trees use one stat per host PID. The previous
 * complete pass estimates IO cost, never authorizes a process or skips a thread in this pass. */
export const readProcTable = measured(readTable);

function readTable(roots: number[], procRoot = '/proc') {
  const names = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  const key = JSON.stringify([procRoot, [...new Set(roots)].sort((a, b) => a - b)]);
  const indexed = (estimates.get(key) ?? 0) > names.length * 1.2;
  const processes = new Map<number, Process>();
  const children = new Map<number, number[]>();
  if (indexed) {
    for (const name of names) {
      const entry = readProcess(procRoot, Number(name));
      if (!entry) continue;
      processes.set(entry.pid, entry);
      const siblings = children.get(entry.parent) ?? [];
      siblings.push(entry.pid);
      children.set(entry.parent, siblings);
    }
  }
  const rows: ProcRow[] = [],
    runners: number[] = [],
    seen = new Set<number>();
  const queue = [...roots];
  let scopedCost = 0;
  while (queue.length) {
    const pid = queue.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const entry = indexed ? processes.get(pid) : readProcess(procRoot, pid);
    if (!entry) continue;
    const { command, threads, ...row } = entry;
    rows.push(row);
    if (command === 'bun' && isRunner(readArgv(procRoot, pid))) runners.push(pid);
    scopedCost += 1 + Math.max(1, threads || 1) + (threads === 1 ? 0 : 1);
    if (indexed) {
      queue.push(...(children.get(pid) ?? []));
      continue;
    }
    let tasks: string[];
    try {
      tasks = threads === 1 ? [String(pid)] : readdirSync(join(procRoot, String(pid), 'task'));
    } catch {
      continue;
    }
    for (const task of tasks) {
      try {
        const ids = readFileSync(
          join(procRoot, String(pid), 'task', task, 'children'),
          'utf8',
        ).trim();
        for (const id of ids.split(/\s+/)) if (/^\d+$/.test(id)) queue.push(Number(id));
      } catch {
        /* A task that exits mid-pass will be reconciled on the next complete pass. */
      }
    }
    if (!Number.isFinite(threads) || threads < 1) scopedCost += tasks.length;
  }
  if (estimates.size >= 32 && !estimates.has(key)) estimates.clear();
  estimates.set(key, scopedCost);
  return { rows, runners, mode: indexed ? ('ppid' as const) : ('task-children' as const) };
}

function readArgv(procRoot: string, pid: number): string[] {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** `bun … ccmux.js _run <name>` (or the source entry in a dev checkout). */
export function isRunner(argv: readonly string[]): boolean {
  const run = argv.indexOf('_run');
  return run > 0 && argv.slice(0, run).some((arg) => /(?:ccmux\.js|cli\.ts)$/.test(arg));
}
