import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { readProcTable } from '../runtime/procTable.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { observeSessionBoundary, type SessionBoundary } from '../session/boundary.ts';
import type { MachineConfig, Session } from '../types.ts';
import { measured } from '../util/cpuScope.ts';

/**
 * Zero-subprocess memory measurement for managed session process trees.
 *
 * - macOS (`darwin`): calls `proc_listchildpids` and `proc_pid_rusage(RUSAGE_INFO_V4)` directly in
 *   `/usr/lib/libSystem.B.dylib` via `bun:ffi` to sum `ri_phys_footprint` across each session's
 *   tree (~17 us/PID, 0 forks, matches Activity Monitor / `footprint` instead of 3.4x-inflated RSS).
 * - Linux (`linux`): reuses `readProcTable` and reads `/proc/<pid>/smaps_rollup` (`Pss` + `SwapPss`,
 *   0 forks).
 *
 * Honesty contract:
 * - Stopped / sleeping sessions report `0`.
 * - Running sessions report `null` before the first sample or when root measurement fails — never `0`.
 */

export const MEMORY_SAMPLE_INTERVAL_MS = 20_000;

const RUSAGE_INFO_V4 = 4;
/** Byte offset of `ri_phys_footprint` (`uint64_t`) in Darwin `struct rusage_info_v4` (`sys/resource.h`). */
const RI_PHYS_FOOTPRINT_U64_INDEX = 9; // 72 / 8
const RUSAGE_V4_BUF_BYTES = 512;
const CHILD_PID_BUF_SLOTS = 256;
const MAX_TREE_PIDS = 1024;

interface DarwinLibProc {
  proc_listchildpids(ppid: number, buffer: Int32Array | null, buffersize: number): number;
  proc_pid_rusage(pid: number, flavor: number, buffer: Uint8Array): number;
}

let darwinLibLoaded = false;
let darwinLib: DarwinLibProc | null = null;
const rusageScratch = new Uint8Array(RUSAGE_V4_BUF_BYTES);
const rusageU64 = new BigUint64Array(rusageScratch.buffer);
const childPidScratch = new Int32Array(CHILD_PID_BUF_SLOTS);

async function loadDarwinLibProc(): Promise<DarwinLibProc | null> {
  if (darwinLibLoaded) return darwinLib;
  darwinLibLoaded = true;
  if (process.platform !== 'darwin') return null;
  try {
    const ffi = await import('bun:ffi');
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      proc_listchildpids: {
        args: [ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
      proc_pid_rusage: {
        args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
    });
    darwinLib = {
      proc_listchildpids: (ppid, buffer, buffersize) =>
        lib.symbols.proc_listchildpids(ppid, buffer === null ? null : ffi.ptr(buffer), buffersize),
      proc_pid_rusage: (pid, flavor, buffer) =>
        lib.symbols.proc_pid_rusage(pid, flavor, ffi.ptr(buffer)),
    };
    return darwinLib;
  } catch {
    darwinLib = null;
    return null;
  }
}

/** Measure unique process-tree `ri_phys_footprint` in bytes on macOS without spawning a subprocess. */
export async function measureDarwinTreeMemory(rootPids: readonly number[]): Promise<number | null> {
  if (rootPids.length === 0) return null;
  const lib = await loadDarwinLibProc();
  if (lib === null) return null;
  const seen = new Set<number>();
  const queue = [...rootPids];
  while (queue.length > 0 && seen.size < MAX_TREE_PIDS) {
    const pid = queue.pop();
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) continue;
    seen.add(pid);
    const count = lib.proc_listchildpids(pid, childPidScratch, childPidScratch.byteLength);
    if (count > 0) {
      const bounded = Math.min(count, childPidScratch.length);
      for (let i = 0; i < bounded; i++) {
        const child = childPidScratch[i];
        if (child !== undefined && child > 1 && !seen.has(child)) queue.push(child);
      }
    }
  }
  const rootSet = new Set(rootPids.filter((pid) => Number.isSafeInteger(pid) && pid > 1));
  let total = 0;
  let measuredRoot = false;
  for (const pid of seen) {
    rusageScratch.fill(0);
    const rc = lib.proc_pid_rusage(pid, RUSAGE_INFO_V4, rusageScratch);
    if (rc !== 0) continue;
    const footprint = Number(rusageU64[RI_PHYS_FOOTPRINT_U64_INDEX] ?? 0n);
    if (Number.isFinite(footprint) && footprint >= 0) {
      total += footprint;
      if (rootSet.has(pid)) measuredRoot = true;
    }
  }
  return measuredRoot ? Math.round(total) : null;
}

/** Parse Linux `/proc/<pid>/smaps_rollup` (`Pss:` + `SwapPss:` in kB) into bytes, or `null` when absent. */
export function parseSmapsRollupBytes(text: string): number | null {
  let pssKb: number | null = null;
  let swapPssKb = 0;
  for (const line of text.split('\n')) {
    const pssMatch = line.match(/^Pss:\s+(\d+)\s+kB/);
    if (pssMatch?.[1] !== undefined) {
      pssKb = Number.parseInt(pssMatch[1], 10);
      continue;
    }
    const swapMatch = line.match(/^SwapPss:\s+(\d+)\s+kB/);
    if (swapMatch?.[1] !== undefined) {
      swapPssKb = Number.parseInt(swapMatch[1], 10);
    }
  }
  if (pssKb === null || !Number.isFinite(pssKb)) return null;
  return (pssKb + (Number.isFinite(swapPssKb) ? swapPssKb : 0)) * 1024;
}

/**
 * Measure unique process-tree `Pss + SwapPss` in bytes for one or more sessions on Linux with a
 * single `readProcTable` scan and per-pass `/proc/<pid>/smaps_rollup` memoization (zero subprocesses).
 */
export function measureLinuxSessionTrees(
  rootsBySession: ReadonlyMap<string, readonly number[]>,
  procRoot = '/proc',
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const allRoots = new Set<number>();
  const cleanedBySession = new Map<string, number[]>();
  for (const [name, roots] of rootsBySession) {
    const valid = [...new Set(roots.filter((pid) => Number.isSafeInteger(pid) && pid > 1))];
    cleanedBySession.set(name, valid);
    for (const pid of valid) allRoots.add(pid);
  }
  if (allRoots.size === 0) {
    for (const name of rootsBySession.keys()) result.set(name, null);
    return result;
  }

  let tableRows: { pid: number; parent: number }[];
  try {
    tableRows = readProcTable([...allRoots], procRoot).rows;
  } catch {
    for (const name of rootsBySession.keys()) result.set(name, null);
    return result;
  }

  const presentPids = new Set<number>();
  const childrenByParent = new Map<number, number[]>();
  for (const row of tableRows) {
    presentPids.add(row.pid);
    const list = childrenByParent.get(row.parent) ?? [];
    list.push(row.pid);
    childrenByParent.set(row.parent, list);
  }

  const smapsCache = new Map<number, number | null>();
  const readSmaps = (pid: number): number | null => {
    if (smapsCache.has(pid)) return smapsCache.get(pid) ?? null;
    let bytes: number | null = null;
    try {
      bytes = parseSmapsRollupBytes(
        readFileSync(join(procRoot, String(pid), 'smaps_rollup'), 'utf8'),
      );
    } catch {
      bytes = null;
    }
    smapsCache.set(pid, bytes);
    return bytes;
  };

  for (const [name, validRoots] of cleanedBySession) {
    if (validRoots.length === 0) {
      result.set(name, null);
      continue;
    }
    const rootSet = new Set(validRoots);
    const seen = new Set<number>();
    const queue = [...validRoots];
    while (queue.length > 0 && seen.size < MAX_TREE_PIDS) {
      const pid = queue.pop();
      if (pid === undefined || seen.has(pid) || !presentPids.has(pid)) continue;
      seen.add(pid);
      for (const child of childrenByParent.get(pid) ?? []) {
        if (!seen.has(child)) queue.push(child);
      }
    }
    let total = 0;
    let measuredRoot = false;
    for (const pid of seen) {
      const bytes = readSmaps(pid);
      if (bytes !== null) {
        total += bytes;
        if (rootSet.has(pid)) measuredRoot = true;
      }
    }
    result.set(name, measuredRoot ? total : null);
  }
  return result;
}

/** Measure unique process-tree `Pss + SwapPss` in bytes for one session on Linux without subprocesses. */
export function measureLinuxTreeMemory(
  rootPids: readonly number[],
  procRoot = '/proc',
): number | null {
  return measureLinuxSessionTrees(new Map([['single', rootPids]]), procRoot).get('single') ?? null;
}

export async function measureTreeMemory(rootPids: readonly number[]): Promise<number | null> {
  if (process.platform === 'darwin') return measureDarwinTreeMemory(rootPids);
  if (process.platform === 'linux') return measureLinuxTreeMemory(rootPids);
  return null;
}

/** Cached daemon memory sampler: runs on a 20s schedule, read in O(1) on every 2s monitoring pass. */
/** A sample older than this is not reported: a refresh that keeps failing must not freeze memory. */
export const MEMORY_SAMPLE_MAX_AGE_MS = 3 * MEMORY_SAMPLE_INTERVAL_MS;

export class MemorySampler {
  private values = new Map<string, number | null>();
  private boundaries = new Map<string, SessionBoundary | null>();
  private sampledAt: number | null = null;

  readonly refresh = measured(
    async (
      m: MachineConfig,
      sessions: readonly Session[],
      sessionPanePids: ReadonlyMap<string, readonly number[]>,
    ): Promise<void> => {
      const next = new Map<string, number | null>();
      const rootsBySession = new Map<string, number[]>();
      for (const s of sessions) {
        if (s.archived) {
          next.set(s.name, 0);
          continue;
        }
        const roots = new Set<number>(sessionPanePids.get(s.name) ?? []);
        if (hasNativeRuntime(s)) {
          const native = readManagedRuntimeStatus(m, s);
          if (native.status === 'live' && native.snapshot !== null) {
            roots.add(native.snapshot.pid);
            if (native.snapshot.providerPid !== null) roots.add(native.snapshot.providerPid);
          }
        }
        if (roots.size === 0) {
          next.set(s.name, null);
          continue;
        }
        rootsBySession.set(s.name, [...roots]);
      }
      if (process.platform === 'linux') {
        const measuredLinux = measureLinuxSessionTrees(rootsBySession);
        for (const [name, bytes] of measuredLinux) next.set(name, bytes);
      } else {
        for (const [name, roots] of rootsBySession) {
          next.set(name, await measureTreeMemory(roots));
        }
      }
      const boundaries = new Map<string, SessionBoundary | null>();
      for (const [name, roots] of rootsBySession)
        boundaries.set(name, await observeSessionBoundary(roots));
      this.values = next;
      this.boundaries = boundaries;
      this.sampledAt = Date.now();
    },
  );

  /**
   * Cached bytes of a session's process tree: `null` before the first sample, when measurement
   * failed, or when the last successful sample is older than `MEMORY_SAMPLE_MAX_AGE_MS`. A stopped or
   * sleeping session's `0` is the monitoring row's decision, not the sampler's.
   */
  memoryFor(name: string, now = Date.now()): number | null {
    if (this.sampledAt === null || now - this.sampledAt > MEMORY_SAMPLE_MAX_AGE_MS) return null;
    return this.values.get(name) ?? null;
  }

  /** The session's process boundary from the same sample, under the same freshness rule. */
  boundaryFor(name: string, now = Date.now()): SessionBoundary | null {
    if (this.sampledAt === null || now - this.sampledAt > MEMORY_SAMPLE_MAX_AGE_MS) return null;
    return this.boundaries.get(name) ?? null;
  }
}
