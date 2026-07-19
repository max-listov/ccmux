import { spawn as nodeSpawn } from "node:child_process";

// The ONLY place external processes are launched (except the foreground claude in
// commands/run.ts). Everything is an argv ARRAY → no shell, no quoting, no globbing.

export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(argv: string[], opts?: { cwd?: string }): Promise<RunResult> {
  const cwd = opts?.cwd;
  const proc = Bun.spawn(argv, {
    ...(cwd !== undefined ? { cwd } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited; // always awaited → no leaked fds
  return { code, stdout, stderr };
}

/** Like `run`, but pipes `input` to the child's stdin — for `tmux load-buffer -` (payload via
 *  stdin avoids argv length limits and any escaping). */
export async function runWithInput(argv: string[], input: string): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
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
  nodeSpawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
