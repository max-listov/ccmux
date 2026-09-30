import { agentPaneTarget } from '../tmux/agentPane.ts';
import { tmuxArgv } from '../tmux/argv.ts';
import { PANE_INVENTORY_FORMAT, parsePaneInventory } from '../tmux/paneInventory.ts';
import type { MachineConfig } from '../types.ts';

const MAX_OUTPUT = 64 * 1024;
let execCount = 0;
let childCpuUs = 0;
export function observationExecCount(): number {
  return execCount;
}
export function observationChildCpuUs(): number {
  return childCpuUs;
}

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
): Promise<{ code: number; stdout: string; stderr: string }> {
  execCount++;
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill('SIGKILL'), deadlineMs());
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
    return { code: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    proc.kill('SIGKILL');
    await proc.exited;
    childCpuUs += Number(proc.resourceUsage()?.cpuTime.total ?? 0);
  }
}

export async function observedSessionInventory(m: MachineConfig): Promise<Map<string, number>> {
  // Printable separator: tmux sanitizes tab to "_" under a boot service's non-UTF-8 locale.
  const result = await invoke(tmuxArgv(m, 'list-panes', '-a', '-F', PANE_INVENTORY_FORMAT));
  // A missing tmux server is positive evidence of no running panes, not an IO failure.
  if (
    result.code !== 0 &&
    !/no server running|no sessions|error connecting .*No such file/.test(result.stderr)
  ) {
    throw new Error('tmux observation unavailable');
  }
  return parsePaneInventory(result.stdout).startedAt;
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
    try {
      const result = await invoke(tmuxArgv(m, ...argv), chunk.length * (MAX_OUTPUT + 128));
      const parts = result.stdout.split(new RegExp(`^${nonce}:\\d+\\n`, 'm'));
      if (result.code !== 0 || parts.length !== chunk.length + 1)
        throw new Error('batch capture unavailable');
      for (const [index, name] of chunk.entries()) {
        const text = parts[index + 1];
        if (text === undefined || Buffer.byteLength(text) > MAX_OUTPUT)
          throw new Error('observation output limit');
        panes.set(name, text);
      }
    } catch {
      // A pane may disappear mid-batch. Retain independent evidence from surviving panes.
      for (const name of chunk) panes.set(name, await observedPane(m, name).catch(() => null));
    }
  }
  return panes;
}

/** Known roots for the Linux OOM pass; no host-wide process discovery. */
export async function observedProcessRoots(m: MachineConfig): Promise<number[]> {
  const result = await invoke(tmuxArgv(m, 'list-panes', '-a', '-F', '#{pane_pid} #{pid}'));
  if (result.code !== 0) {
    if (/no server running|no sessions|error connecting .*No such file/.test(result.stderr))
      return [];
    throw new Error('tmux process roots unavailable');
  }
  const roots = new Set<number>();
  for (const token of result.stdout.trim().split(/\s+/)) {
    if (!token) continue;
    const pid = Number(token);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid tmux process root');
    roots.add(pid);
  }
  return [...roots];
}
