import { paneTarget } from '../tmux/target.ts';
import { tmuxArgv } from '../tmux/tmux.ts';
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
async function invoke(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
        if (length > MAX_OUTPUT) {
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
  const result = await invoke(
    tmuxArgv(m, 'list-sessions', '-F', '#{session_name} #{session_created}'),
  );
  // A missing tmux server is positive evidence of no running panes, not an IO failure.
  if (
    result.code !== 0 &&
    !/no server running|no sessions|error connecting .*No such file/.test(result.stderr)
  ) {
    throw new Error('tmux observation unavailable');
  }
  const sessions = new Map<string, number>();
  for (const line of result.stdout.trim().split('\n')) {
    if (!line) continue;
    const delimiter = line.lastIndexOf(' ');
    const name = line.slice(0, delimiter);
    const epoch = Number(line.slice(delimiter + 1));
    if (!name || !Number.isFinite(epoch) || epoch <= 0) throw new Error('invalid tmux observation');
    sessions.set(name, epoch);
  }
  return sessions;
}

export async function observedPane(m: MachineConfig, name: string): Promise<string | null> {
  const result = await invoke(
    tmuxArgv(m, 'capture-pane', '-t', paneTarget(name), '-p', '-S', '-40'),
  );
  return result.code === 0 ? result.stdout : null;
}
