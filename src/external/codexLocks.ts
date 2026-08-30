import { existsSync, realpathSync } from 'node:fs';
import type { MachineConfig } from '../types.ts';
import { isDescendantProcess, type ProcessSnapshot, processSnapshot } from './processes.ts';

export type CodexLockHolder = {
  pid: number;
  command: string | null;
};

export type CodexLockInspection = {
  evidence: 'observed' | 'none-observed' | 'unknown';
  path: string;
  holders: CodexLockHolder[];
};

function lsofBin(): string | null {
  const detected = Bun.which('lsof');
  if (detected) return detected;
  if (existsSync('/usr/sbin/lsof')) return '/usr/sbin/lsof';
  if (existsSync('/usr/bin/lsof')) return '/usr/bin/lsof';
  return null;
}

export function codexThreadLockPath(m: MachineConfig, threadId: string): string | null {
  if (!m.codexHome) return null;
  const path = `${m.codexHome}/thread-writer-locks/${threadId}.lock`;
  // lsof reports canonical names. macOS exposes the temp root as /var/... while the kernel reports
  // /private/var/...; comparing the unresolved spelling made a real held lock look unobserved.
  return existsSync(path) ? realpathSync(path) : path;
}

/** Parse lsof field output (`-Fpcn`) without trusting human-aligned columns. */
export function parseLsofHolders(output: string, exactPath: string): CodexLockHolder[] {
  const holders: CodexLockHolder[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  let names: string[] = [];
  const flush = (): void => {
    if (pid !== null && names.includes(exactPath)) holders.push({ pid, command });
    pid = null;
    command = null;
    names = [];
  };
  for (const field of output.split('\n')) {
    if (field.startsWith('p')) {
      flush();
      const value = Number(field.slice(1));
      pid = Number.isInteger(value) && value > 0 ? value : null;
    } else if (field.startsWith('c')) {
      command = field.slice(1) || null;
    } else if (field.startsWith('n')) {
      names.push(field.slice(1));
    }
  }
  flush();
  return holders;
}

/** Exact, read-only writer evidence for one Codex thread. An unheld stale lock file is not live. */
export function inspectCodexThreadLock(m: MachineConfig, threadId: string): CodexLockInspection {
  const path = codexThreadLockPath(m, threadId);
  if (!path) return { evidence: 'unknown', path: '', holders: [] };
  const bin = lsofBin();
  if (!bin) return { evidence: 'unknown', path, holders: [] };
  try {
    const result = Bun.spawnSync([bin, '-Fpcn', '--', path], { stderr: 'ignore' });
    // lsof uses exit 1 for a valid query with no matching open file.
    if (result.exitCode !== 0 && result.exitCode !== 1)
      return { evidence: 'unknown', path, holders: [] };
    const holders = parseLsofHolders(result.stdout.toString(), path);
    return { evidence: holders.length > 0 ? 'observed' : 'none-observed', path, holders };
  } catch {
    return { evidence: 'unknown', path, holders: [] };
  }
}

/** One lsof query for a discovery poll, rather than one subprocess per stored rollout. */
export function inspectCodexThreadLocks(
  m: MachineConfig,
  threadIds: string[],
): Map<string, CodexLockInspection> {
  const out = new Map<string, CodexLockInspection>();
  const bin = lsofBin();
  const entries = threadIds.flatMap((threadId) => {
    const path = codexThreadLockPath(m, threadId);
    return path ? [{ threadId, path }] : [];
  });
  if (!bin || entries.length !== threadIds.length) {
    for (const entry of entries)
      out.set(entry.threadId, { evidence: 'unknown', path: entry.path, holders: [] });
    return out;
  }
  for (let offset = 0; offset < entries.length; offset += 100) {
    const chunk = entries.slice(offset, offset + 100);
    try {
      const result = Bun.spawnSync([bin, '-Fpcn', '--', ...chunk.map((entry) => entry.path)], {
        stderr: 'ignore',
      });
      const reliable = result.exitCode === 0 || result.exitCode === 1;
      const output = result.stdout.toString();
      for (const entry of chunk) {
        const holders = reliable ? parseLsofHolders(output, entry.path) : [];
        out.set(entry.threadId, {
          evidence: reliable ? (holders.length > 0 ? 'observed' : 'none-observed') : 'unknown',
          path: entry.path,
          holders,
        });
      }
    } catch {
      for (const entry of chunk)
        out.set(entry.threadId, { evidence: 'unknown', path: entry.path, holders: [] });
    }
  }
  return out;
}

export function lockHeldByDescendant(
  inspection: CodexLockInspection,
  rows: ProcessSnapshot[],
  ancestorPid: number,
): boolean {
  return inspection.holders.some(
    (holder) => holder.pid === ancestorPid || isDescendantProcess(rows, holder.pid, ancestorPid),
  );
}

/** Bootstrap admission: true only when this exact thread lock is held by our spawned subtree. */
export function codexLockHeldByDescendant(
  m: MachineConfig,
  threadId: string,
  ancestorPid: number,
): boolean {
  const inspection = inspectCodexThreadLock(m, threadId);
  if (inspection.evidence !== 'observed') return false;
  const rows = processSnapshot();
  return rows !== null && lockHeldByDescendant(inspection, rows, ancestorPid);
}
