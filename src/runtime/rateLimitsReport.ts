// Pure types, no imports: the plan windows a terminal Claude status line reported. They live apart
// from both the metrics file (node:fs) and the plan-limits projection (zod) so that neither pulls the
// other into a bundle that must not carry it — the packaged control client is built from the latter.

export interface RateLimitWindow {
  /** `used_percentage`, as reported. */
  pct: number;
  /** `resets_at`, epoch SECONDS as reported; null when absent. */
  resetsAt: number | null;
}

export interface RateLimitsReport {
  /** When the render that carried these windows happened (ms). */
  at: number;
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
}
