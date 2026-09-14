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
 */
export type LoopStall = { blockedMs: number; cpuMs: number };

export function watchLoopStalls(
  onStall: (stall: LoopStall) => void,
  periodMs = 1_000,
  thresholdMs = 5_000,
): () => void {
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(lastCpu);
    const late = now - last - periodMs;
    last = now;
    lastCpu = process.cpuUsage();
    if (late >= thresholdMs)
      onStall({ blockedMs: Math.round(late), cpuMs: Math.round((cpu.user + cpu.system) / 1_000) });
  }, periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
