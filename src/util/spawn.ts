import { spawn as nodeSpawn } from 'node:child_process';

// The ONLY place external processes are launched (except the foreground claude in
// commands/run.ts). Everything is an argv ARRAY → no shell, no quoting, no globbing.

export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };

/** Kill the child once `timeoutMs` elapses; returns a canceller so the happy path clears the timer.
 *  Needed for anything that talks to the network (ssh): a blackholed route never refuses and never
 *  returns, so without a deadline the caller hangs forever instead of failing honestly. */
function armTimeout(
  proc: { kill: (sig?: number | NodeJS.Signals) => void },
  timeoutMs: number | undefined,
  onFire: () => void,
): () => void {
  if (timeoutMs === undefined) return () => {};
  const t = setTimeout(() => {
    onFire();
    proc.kill('SIGKILL');
  }, timeoutMs);
  return () => clearTimeout(t);
}

/**
 * Run a child to completion and collect what it printed. `input`, when given, is the child's
 * stdin — for `tmux load-buffer -`, where a payload via stdin avoids argv length limits and any
 * escaping; otherwise stdin is closed.
 */
/** How long the pipes of a child that was killed on purpose may keep us waiting. */
const KILLED_PIPES_GRACE_MS = 1_000;

/** The whole text of a pipe, readable to the end or released early with whatever arrived. */
function collect(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const text = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
    } catch {
      // released early: what arrived is what there is
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  return { text, cancel: () => void reader.cancel().catch(() => {}) };
}

export async function run(
  argv: string[],
  opts?: {
    cwd?: string;
    timeoutMs?: number;
    input?: string;
    /** The child's whole environment. Omitted = inherit this process's. */
    env?: Record<string, string>;
    signal?: AbortSignal | undefined;
  },
): Promise<RunResult> {
  opts?.signal?.throwIfAborted();
  const cwd = opts?.cwd;
  const proc = Bun.spawn(argv, {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    stdin: opts?.input === undefined ? 'ignore' : new TextEncoder().encode(opts.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  // Killing the child does not close its pipes when a grandchild inherited them (a shell's `sleep`,
  // a program's helper): reading to the end would then wait for the grandchild. A child that was
  // killed on purpose is given a moment to flush, then its pipes are let go.
  let released: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    released = setTimeout(() => {
      out.cancel();
      err.cancel();
    }, KILLED_PIPES_GRACE_MS);
  };
  const abort = () => {
    proc.kill('SIGKILL');
    release();
  };
  opts?.signal?.addEventListener('abort', abort, { once: true });
  if (opts?.signal?.aborted) abort();
  let timedOut = false;
  const disarm = armTimeout(proc, opts?.timeoutMs, () => {
    timedOut = true;
    release();
  });
  const [stdout, stderr] = await Promise.all([out.text, err.text]);
  clearTimeout(released);
  const code = await proc.exited; // always awaited → no leaked fds
  disarm();
  opts?.signal?.removeEventListener('abort', abort);
  opts?.signal?.throwIfAborted();
  return timedOut ? { code, stdout, stderr, timedOut } : { code, stdout, stderr };
}

/**
 * Fire-and-forget a fully detached child in its OWN process group.
 *
 * P3-14: `detached: true` (not just `.unref()`) is required so the child survives
 * `tmux kill-session`'s SIGHUP-to-the-process-group — that's how `restart` can kill
 * the very session it is invoked from and still come back. Bun.spawn has no
 * `detached` option, so we use node:child_process (Bun implements its detached
 * process-group semantics) — root cause, no type suppression.
 */
export function runDetached(argv: string[]): void {
  const [cmd, ...args] = argv;
  if (cmd === undefined) return;
  // The current environment, named: left implicit, a child gets the one this process STARTED with,
  // and a variable set since would silently not reach it.
  nodeSpawn(cmd, args, { detached: true, stdio: 'ignore', env: process.env }).unref();
}
