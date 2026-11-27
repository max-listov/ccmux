import { type RefusalCode, refusals } from '../../control/schema/refusals.ts';
import {
  isDescendantProcess,
  processSnapshot,
  processSnapshotAsync,
} from '../../external/processes.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { readManagedRuntimeStatus } from '../../runtime/status.ts';
import { forgetAgentPane } from '../../tmux/agentPane.ts';
import { hasSession, killSession } from '../../tmux/tmux.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { clearStatus } from '../status.ts';
import { isProviderExecutable } from './processTree.ts';
import { listSessionPanes } from './proof.ts';
import type { SleepRecord } from './schema.ts';

function refuse(code: RefusalCode, message: string): never {
  throw refusals.errors[code]({ message });
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists under another uid; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function processesReleased(row: SleepRecord): boolean {
  if (row.proof.processes.length === 0) return true;
  if (row.proof.processes.every((held) => !pidExists(held.pid))) return true;
  const processes = processSnapshot();
  return (
    processes !== null &&
    row.proof.processes.every(
      (held) =>
        !processes.some(
          (current) => held.pid === current.pid && held.startTime === current.startTime,
        ),
    )
  );
}

/** Async non-blocking process release check (fast `kill(pid, 0)` path + async `ps`). */
export async function processesReleasedAsync(
  row: SleepRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  if (row.proof.processes.length === 0) return true;
  if (row.proof.processes.every((held) => !pidExists(held.pid))) return true;
  const processes = await processSnapshotAsync(signal);
  return (
    processes !== null &&
    row.proof.processes.every(
      (held) =>
        !processes.some(
          (current) => held.pid === current.pid && held.startTime === current.startTime,
        ),
    )
  );
}

export async function awaitRelease(
  row: SleepRecord,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await processesReleasedAsync(row, signal))) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) return false;
    await Bun.sleep(150);
  }
  return true;
}

export async function tmuxSessionAlive(
  m: MachineConfig,
  name: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  try {
    return await hasSession(m, name, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

function signalConfirmedProcesses(
  row: SleepRecord,
  rows: readonly { pid: number; startTime: string }[] | null,
  sig: 'SIGTERM' | 'SIGKILL',
): void {
  if (rows === null) return;
  for (const held of row.proof.processes) {
    const alive = rows.some(
      (current) => current.pid === held.pid && current.startTime === held.startTime,
    );
    if (!alive) continue;
    try {
      process.kill(held.pid, sig);
    } catch {
      /* exited concurrently */
    }
  }
}

/**
 * Stop an interactive TUI session whose `sleep.json` is already in `phase: 'requested'`.
 *
 * 1. `SIGTERM` the agent process first (`claude`/`codex`, not `_run`) so it flushes JSONL and
 *    closes stdio MCP children cleanly; `_run` sees `sleepBlocksStart` after `proc.exited` and
 *    exits 0 without writing a LifecycleBlock or sleeping in backoff.
 * 2. After the 4s grace window (or if tmux is still alive), call `killSession` and signal any
 *    remaining `(pid, startTime)` entries from `row.proof.processes` (`SIGTERM`, then `SIGKILL`).
 * 3. Always clear stale status files and cached agent pane id once gone.
 */
export async function releaseTuiProcesses(
  m: MachineConfig,
  s: Session,
  row: SleepRecord,
  signal: AbortSignal,
): Promise<void> {
  const initialRows = await processSnapshotAsync(signal);
  const panes = await listSessionPanes(m, s.name, signal);
  const panePid = panes?.[0]?.panePid;
  if (
    initialRows !== null &&
    panePid !== undefined &&
    (s.agent === 'claude' || s.agent === 'codex')
  ) {
    const providerId = s.agent;
    const providerBin = providerId === 'claude' ? m.claudeBin : m.codexBin;
    const agent = initialRows.find(
      (proc) =>
        proc.ppid === panePid &&
        row.proof.processes.some((h) => h.pid === proc.pid && h.startTime === proc.startTime) &&
        isProviderExecutable(proc, providerId, providerBin),
    );
    if (agent !== undefined) {
      try {
        process.kill(agent.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await awaitRelease(row, signal, 4_000);
    }
  }

  if (await hasSession(m, s.name, signal)) {
    await killSession(m, s.name);
  }

  if (!(await processesReleasedAsync(row, signal))) {
    const remaining = await processSnapshotAsync(signal);
    signalConfirmedProcesses(row, remaining, 'SIGTERM');
    await awaitRelease(row, signal, 3_000);
  }
  if (!(await processesReleasedAsync(row, signal))) {
    const stubborn = await processSnapshotAsync(signal);
    signalConfirmedProcesses(row, stubborn, 'SIGKILL');
    const released = await awaitRelease(row, signal, 3_000);
    if (!released) {
      refuse(
        'SLEEP_PENDING',
        'TUI process tree has not confirmed release; retry the same operation',
      );
    }
  }
  if (await hasSession(m, s.name, signal)) {
    await killSession(m, s.name);
  }
  clearStatus(s.name);
  forgetAgentPane(m, s.name);
}

/** Verify a fresh `(pid, startTime)` incarnation distinct from the slept process tree. */
export async function sessionHasFreshLiveProcess(
  m: MachineConfig,
  s: Session,
  row: SleepRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  if (hasNativeRuntime(s)) {
    const read = readManagedRuntimeStatus(m, s);
    if (read.status !== 'live' || read.snapshot === null) return false;
    const pid = read.snapshot.pid;
    const rows = await processSnapshotAsync(signal);
    const liveRow = rows?.find((entry) => entry.pid === pid);
    if (liveRow === undefined) return false;
    return !row.proof.processes.some(
      (held) => held.pid === liveRow.pid && held.startTime === liveRow.startTime,
    );
  }
  const panes = await listSessionPanes(m, s.name, signal);
  if (panes === null || panes.length === 0) return false;
  const agentPane =
    panes.find((pane) => pane.agentPaneId !== null && pane.paneId === pane.agentPaneId) ?? panes[0];
  if (agentPane === undefined) return false;
  const rows = await processSnapshotAsync(signal);
  if (rows === null) return false;
  const paneRow = rows.find((entry) => entry.pid === agentPane.panePid);
  if (paneRow === undefined) return false;
  if (
    row.proof.processes.some(
      (held) => held.pid === paneRow.pid && held.startTime === paneRow.startTime,
    )
  ) {
    return false;
  }
  if (s.agent !== 'claude' && s.agent !== 'codex') return true;
  const providerId = s.agent;
  const providerBin = providerId === 'claude' ? m.claudeBin : m.codexBin;
  return rows.some(
    (entry) =>
      isDescendantProcess(rows, entry.pid, paneRow.pid) &&
      isProviderExecutable(entry, providerId, providerBin),
  );
}
