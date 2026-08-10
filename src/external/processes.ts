export type ProcessSnapshot = {
  pid: number;
  ppid: number;
  processGroup: number;
  startTime: string;
  command: string;
};

/** Parse the portable fields emitted by `ps -axww -o pid=,ppid=,pgid=,lstart=,command=`. */
export function parseProcessSnapshot(output: string): ProcessSnapshot[] {
  const rows: ProcessSnapshot[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const processGroup = Number(match[3]);
    const startTime = match[4];
    const command = match[5];
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid) ||
      !Number.isInteger(processGroup) ||
      startTime === undefined ||
      command === undefined
    ) continue;
    rows.push({ pid, ppid, processGroup, startTime, command });
  }
  return rows;
}

export function processSnapshot(): ProcessSnapshot[] | null {
  try {
    const result = Bun.spawnSync(["ps", "-axww", "-o", "pid=,ppid=,pgid=,lstart=,command="], {
      stderr: "ignore",
    });
    if (!result.success) return null;
    return parseProcessSnapshot(result.stdout.toString());
  } catch {
    return null;
  }
}

/** Strict descendant check: a process is not its own descendant. */
export function isDescendantProcess(rows: ProcessSnapshot[], pid: number, ancestorPid: number): boolean {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && current.ppid > 1 && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (current.ppid === ancestorPid) return true;
    current = byPid.get(current.ppid);
  }
  return false;
}

export function processAncestors(rows: ProcessSnapshot[], pid: number): ProcessSnapshot[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors: ProcessSnapshot[] = [];
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && !seen.has(current.pid)) {
    ancestors.push(current);
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return ancestors;
}
