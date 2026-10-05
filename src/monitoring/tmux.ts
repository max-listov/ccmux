import { agentPaneTarget, rememberAgentPane } from '../tmux/agentPane.ts';
import { tmuxArgv } from '../tmux/argv.ts';
import { PANE_INVENTORY_FORMAT, parsePaneInventory } from '../tmux/paneInventory.ts';
import type { MachineConfig } from '../types.ts';
import { matchingProcessRoots, readProcessStart } from '../util/procStat.ts';
import { producerMetrics } from '../util/producerMetrics.ts';

const MAX_OUTPUT = 64 * 1024;
const inventories = new Map<
  string,
  {
    at: number;
    roots: number[];
    rootStarts: Map<number, string>;
    agentPanes: Map<string, string>;
    peerLineLimits: Map<string, number>;
  }
>();
/** How long an observation inventory stands in for a fresh one, for its readers outside the pass. */
export const INVENTORY_FRESH_MS = 10_000;
const inventoryKey = (m: MachineConfig) => JSON.stringify([m.stateDir, m.tmuxSocket, m.tmuxBin]);

/** Process roots from the last inventory, or `null` when there is none fresh enough to trust. */
export function observedProcessRoots(m: MachineConfig, nowMs = Date.now()): number[] | null {
  const inventory = inventories.get(inventoryKey(m));
  if (!inventory || nowMs - inventory.at > INVENTORY_FRESH_MS) return null;
  if (process.platform !== 'linux') return [...inventory.roots];
  return matchingProcessRoots(inventory.rootStarts, readProcessStart);
}

/**
 * Roots for a pass that must not run on a guess: the observation's when fresh, else a new inventory.
 * The OOM pass reads these every two seconds, and observation lags exactly when the host is loaded —
 * the moment the OOM pass exists for. Falling back to "no roots" protected only the daemon, silently.
 */
export async function processRoots(m: MachineConfig, nowMs = Date.now()): Promise<number[]> {
  const roots = observedProcessRoots(m, nowMs);
  if (roots !== null) return roots;
  await observedSessionInventory(m);
  return observedProcessRoots(m) ?? [];
}

export function observedAgentPanes(m: MachineConfig): ReadonlyMap<string, string> {
  return inventories.get(inventoryKey(m))?.agentPanes ?? new Map();
}

/** capture-pane -S -30 includes the visible pane plus up to thirty scrollback lines. */
export function observedPeerPanes(m: MachineConfig, panes: ReadonlyMap<string, string | null>) {
  const limits = inventories.get(inventoryKey(m))?.peerLineLimits;
  return new Map(
    [...panes].map(([name, text]) => {
      if (text === null) return [name, null] satisfies [string, string | null];
      const limit = limits?.get(name);
      if (limit === undefined) throw new Error('agent pane height unavailable');
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return [name, `${lines.slice(-limit).join('\n')}\n`] satisfies [string, string | null];
    }),
  );
}
let execCount = 0;
let childCpuUs = 0;
producerMetrics.register('observation', () => ({ execCount, childCpuUs }));

/**
 * Bounded producer IO: one child at a time, 64 KiB per stream, one-second deadline.
 *
 * The deadline is what keeps a hung producer from stalling an observation pass, and one second is
 * the right size for the real one. It is overridable because a machine under enough load to make a
 * shell take longer than that is not a machine with a hung producer — and a check that reports load
 * as a defect is the kind that gets switched off.
 */
// Read per call, not at import: a value captured when the module loads cannot be overridden by
// anything that happens afterwards, which would make the override above true only in the comment.
const deadlineMs = (): number => Number(process.env.CCMUX_OBSERVE_DEADLINE_MS ?? 1000);
async function invoke(
  argv: string[],
  maxOutput = MAX_OUTPUT,
  deadline = deadlineMs(),
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  execCount++;
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, deadline);
  async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxOutput) {
          proc.kill('SIGKILL');
          await reader.cancel();
          throw new Error('observation output limit');
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
    return { code: await proc.exited, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
    proc.kill('SIGKILL');
    await proc.exited;
    childCpuUs += Number(proc.resourceUsage()?.cpuTime.total ?? 0);
  }
}

export async function observedSessionInventory(m: MachineConfig): Promise<Map<string, number>> {
  // Printable separator: tmux sanitizes tab to "_" under a boot service's non-UTF-8 locale.
  const result = await invoke(
    tmuxArgv(
      m,
      'list-panes',
      '-a',
      '-F',
      `${PANE_INVENTORY_FORMAT}|#{pane_pid}|#{pid}|#{pane_height}`,
    ),
  );
  // A missing tmux server is positive evidence of no running panes, not an IO failure.
  if (
    result.code !== 0 &&
    !/no server running|no sessions|error connecting .*No such file/.test(result.stderr)
  ) {
    throw new Error('tmux observation unavailable');
  }
  const parsed = parsePaneInventory(result.stdout, true);
  // The pane each session records is the truth; this process's cache is only a memory of it. A
  // session restarted by another process (`ccmux restart --all` from a shell) gets a new pane, and a
  // cache left on the old id would aim every capture at a pane that no longer exists.
  for (const [name, pane] of parsed.agentPanes) rememberAgentPane(m, name, pane);
  const roots = parsed.roots;
  const rootStarts = new Map<number, string>();
  if (process.platform === 'linux')
    for (const pid of roots) {
      const start = readProcessStart(pid);
      if (start !== null) rootStarts.set(pid, start);
    }
  if (inventories.size >= 32) inventories.delete(inventories.keys().next().value ?? '');
  inventories.set(inventoryKey(m), {
    at: Date.now(),
    roots: [...roots],
    rootStarts,
    agentPanes: parsed.agentPanes,
    peerLineLimits: parsed.peerLineLimits,
  });
  return parsed.startedAt;
}

export async function observedPane(m: MachineConfig, name: string): Promise<string | null> {
  const result = await invoke(
    tmuxArgv(m, 'capture-pane', '-t', await agentPaneTarget(m, name), '-p', '-S', '-40'),
  );
  return result.code === 0 ? result.stdout : null;
}

/** Eight captures per child, preserving every observation and exact agent pane target. */
export async function observedPanes(
  m: MachineConfig,
  names: string[],
): Promise<Map<string, string | null>> {
  const panes = new Map<string, string | null>();
  for (let offset = 0; offset < names.length; offset += 8) {
    const chunk = names.slice(offset, offset + 8);
    const nonce = `ccmux-${crypto.randomUUID()}`;
    const argv: string[] = [];
    for (const [index, name] of chunk.entries()) {
      if (index) argv.push(';');
      argv.push(
        'display-message',
        '-p',
        `${nonce}:${index}`,
        ';',
        'capture-pane',
        '-t',
        await agentPaneTarget(m, name),
        '-p',
        '-S',
        '-40',
      );
    }
    // One deadline per capture the child performs: the batch does the work of the whole chunk.
    const result = await invoke(
      tmuxArgv(m, ...argv),
      chunk.length * (MAX_OUTPUT + 128),
      deadlineMs() * chunk.length,
    ).catch(() => null);
    const parts = result?.stdout.split(new RegExp(`^${nonce}:\\d+\\n`, 'm'));
    const texts =
      result !== null && result.code === 0 && parts?.length === chunk.length + 1
        ? parts.slice(1)
        : null;
    if (texts?.every((text) => Buffer.byteLength(text) <= MAX_OUTPUT)) {
      for (const [index, name] of chunk.entries()) panes.set(name, texts[index] ?? null);
      continue;
    }
    // A slow or oversized batch says the same thing about every pane in it: retrying them one by one
    // would multiply the load that made it slow. Only a pane that vanished mid-batch (tmux refused a
    // target) leaves the others' evidence worth fetching on their own.
    if (result === null || result.timedOut || texts !== null) {
      for (const name of chunk) panes.set(name, null);
      continue;
    }
    for (const name of chunk) panes.set(name, await observedPane(m, name).catch(() => null));
  }
  return panes;
}
