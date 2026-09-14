/**
 * Report when the daemon's event loop stopped turning, and for how long.
 *
 * Everything the daemon does — observation, control calls, delivery — shares one loop, so one
 * synchronous call that blocks freezes all of it, and nothing else in the process can notice: every
 * timer that would have noticed is frozen too. A timer that measures its own lateness is the one
 * observer that still reports afterwards. It names the stall; finding what held the loop is a
 * separate step (`sample <pid>` on macOS shows the stack while it happens).
 */
export function watchLoopStalls(
  onStall: (blockedMs: number) => void,
  periodMs = 1_000,
  thresholdMs = 5_000,
): () => void {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - periodMs;
    last = now;
    if (late >= thresholdMs) onStall(Math.round(late));
  }, periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
