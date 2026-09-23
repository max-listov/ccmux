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
export async function run(
  argv: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string },
): Promise<RunResult> {
  const cwd = opts?.cwd;
  const proc = Bun.spawn(argv, {
    ...(cwd !== undefined ? { cwd } : {}),
    stdin: opts?.input === undefined ? 'ignore' : new TextEncoder().encode(opts.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const disarm = armTimeout(proc, opts?.timeoutMs, () => {
    timedOut = true;
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited; // always awaited → no leaked fds
  disarm();
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
