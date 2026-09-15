/**
 * Report when the daemon's event loop stopped turning, and for how long.
 *
 * Everything the daemon does — observation, control calls, delivery — shares one loop, so one
 * synchronous call that blocks freezes all of it, and nothing else in the process can notice: every
 * timer that would have noticed is frozen too. A timer that measures its own lateness is the one
 * observer that still reports afterwards. It names the stall; finding what held the loop is a
 * separate step (`sample <pid>` on macOS shows the stack while it happens).
 *
 * A stall has two causes that call for opposite fixes, and the length alone cannot tell them apart:
 * this process was busy — synchronous work of its own — or it was not running at all, waiting in a
 * blocking system call or not given a CPU by a loaded host. `cpuMs` is the CPU time the whole process
 * spent across the same window: close to `blockedMs` means the first, close to zero the second.
 *
 * A process that was not running is itself two different stories, and the kernel counts both:
 * `majorFaults` are page faults served from disk — its memory had been paged out and it waited to
 * get it back; `preemptions` are the times the scheduler took the CPU away while it wanted to run —
 * a loaded host. Neither is a statement about this process's code; both are the window's deltas.
 * (Voluntary switches would name the third story, a blocking call, but Bun on macOS reports them as
 * zero, so a stall with neither counter is read as that by elimination.)
 */
export type LoopStall = {
  blockedMs: number;
  cpuMs: number;
  majorFaults: number;
  preemptions: number;
};

export type ProcessCounters = { cpuMicros: number; majorFaults: number; preemptions: number };

export function processCounters(): ProcessCounters {
  const usage = process.resourceUsage();
  return {
    cpuMicros: usage.userCPUTime + usage.systemCPUTime,
    majorFaults: usage.majorPageFault,
    preemptions: usage.involuntaryContextSwitches,
  };
}

export function watchLoopStalls(
  onStall: (stall: LoopStall) => void,
  periodMs = 1_000,
  thresholdMs = 5_000,
  counters: () => ProcessCounters = processCounters,
): () => void {
  let last = performance.now();
  let before = counters();
  const timer = setInterval(() => {
    const now = performance.now();
    const after = counters();
    const late = now - last - periodMs;
    last = now;
    if (late >= thresholdMs)
      onStall({
        blockedMs: Math.round(late),
        cpuMs: Math.round((after.cpuMicros - before.cpuMicros) / 1_000),
        majorFaults: after.majorFaults - before.majorFaults,
        preemptions: after.preemptions - before.preemptions,
      });
    before = after;
  }, periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
