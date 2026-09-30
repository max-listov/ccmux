/** Linux comm can contain spaces and parentheses; fields start after its last closing bracket.
 * Select only PPID, thread count and birth time instead of allocating all 50+ numeric fields. */
export function parseProcessStat(raw: string) {
  const open = raw.indexOf('('),
    close = raw.lastIndexOf(')');
  if (open === -1 || close < open) return null;
  const suffix = raw.slice(close + 1);
  const full = /^\s*\S+\s+(\d+)(?:\s+\S+){15}\s+(\d+)\s+\S+\s+(\d+)(?:\s|$)/.exec(suffix);
  const parent = Number((full ?? /^\s*\S+\s+(\d+)(?:\s|$)/.exec(suffix))?.[1]);
  if (!Number.isSafeInteger(parent)) return null;
  return {
    parent,
    command: raw.slice(open + 1, close),
    startTime: full?.[3],
    threads: Number(full?.[2]),
  };
}

/** Cached numeric roots never authorize a different process that later reused the PID. */
export function matchingProcessRoots(
  roots: ReadonlyMap<number, string>,
  readStart: (pid: number) => string | null,
): number[] {
  return [...roots].flatMap(([pid, expected]) => (readStart(pid) === expected ? [pid] : []));
}
