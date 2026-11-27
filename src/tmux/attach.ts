import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { tmuxArgv } from './argv.ts';

export function insideTmux(): boolean {
  return process.env.TMUX !== undefined && process.env.TMUX !== '';
}

/** Hand the terminal cleanly to tmux before attaching. The REAL fix is releasing stdin:
 *  Ink may leave it flowing after unmount, and a still-reading parent steals bytes from the
 *  inherited fd -> tmux attach can't get exclusive control -> broken render + exit 1.
 *  We do NOT re-send alt-screen/mouse resets — the App's own effects tear those down per-mode
 *  on unmount; re-sending `?1049l` in inline mode (never in alt-screen) garbles the buffer
 *  with stray chars. Only ensure raw mode is off and the cursor is visible. */
export function cleanTerminalForAttach(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    process.stdin.pause();
  } catch {
    /* best effort */
  }
  process.stdout.write('\x1b[?25h'); // restore cursor (Ink hides it)
}

/** Hand the terminal to tmux for the session, block until detach, then return so the
 *  menu can re-render. Inside tmux we switch-client (returns at once) instead of nesting.
 *
 *  Uses Bun.spawnSync (NOT async spawn) on purpose. Root cause of the intermittent
 *  "attach then instantly exits (code 1)" / "breaks the moment you type" bug: with async
 *  spawn the parent's event loop keeps running while tmux is attached, and Bun/libuv still
 *  holds fd 0 (the terminal) — so the parent and the tmux client both poll the same tty and
 *  fight over input bytes and terminal setup. A plain shell `tmux attach` never hits this
 *  because the shell is blocked in waitpid for the whole attach, touching nothing. spawnSync
 *  reproduces exactly that: it freezes our event loop until tmux exits, so the tmux client is
 *  the sole owner of the terminal. Inherited fd 0/1/2 (not /dev/tty — VS Code's pty has no
 *  usable controlling terminal, so `open /dev/tty` fails there). */
export function attachTmux(m: MachineConfig, name: string): number {
  const args = insideTmux() ? ['switch-client', '-t', `=${name}`] : ['attach', '-t', `=${name}`];
  log.info({
    msg: 'attach',
    name,
    mode: args[0],
    tty: process.stdout.isTTY,
    term: process.env.TERM,
  });
  const r = Bun.spawnSync(tmuxArgv(m, ...args), {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'pipe',
  });
  const err = r.stderr ? r.stderr.toString().trim() : '';
  log.info({ msg: 'attach exited', name, code: r.exitCode, stderr: err.slice(0, 300) });
  if (r.exitCode !== 0 && err !== '') {
    process.stderr.write(`${err}\n`);
  }
  return r.exitCode;
}
