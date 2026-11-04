import { dlopen, FFIType } from 'bun:ffi';

/** SIGTTIN and SIGTTOU have the same numbers on Linux and macOS, the two platforms ccmux runs on. */
const SIGTTIN = 21;
const SIGTTOU = 22;
/** `SIG_IGN` is the handler value 1. */
const SIG_IGN = 1;

/**
 * Make terminal job-control stops impossible for the rest of this process.
 *
 * A process outside the terminal's foreground group that changes the terminal mode or reads from it is
 * stopped by the kernel with SIGTTOU/SIGTTIN. Only IGNORING the signal changes that: the mode change
 * then goes through and a read fails with EIO. A JavaScript handler does not — Bun installs it with
 * SA_RESTART, so the interrupted `tcsetattr` restarts, raises the signal again, and loops (traced on
 * Linux as ERESTARTSYS). Bun exposes no way to ignore a signal, so it is `signal(2)` from libc.
 *
 * Used on the way out only: a process that is exiting has no children left to inherit the ignored
 * disposition, and no reason to wait in the background for its terminal.
 */
export function ignoreTerminalStops(): void {
  try {
    const libc = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', {
      signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    });
    libc.symbols.signal(SIGTTOU, SIG_IGN);
    libc.symbols.signal(SIGTTIN, SIG_IGN);
  } catch {
    // Without libc the exit proceeds as before; the hangup path still does not touch the terminal.
  }
}
