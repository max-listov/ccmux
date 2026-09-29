import type { MachineConfig } from '../types.ts';

/** Base tmux argv, scoped to the config's optional dedicated socket (`-L`). EVERY tmux invocation
 *  goes through this, so an isolated instance (dev) is fully confined to its own tmux server. Unset
 *  socket → the default socket (prod), i.e. current behaviour. Exported for the test. */
export function tmuxArgv(m: MachineConfig, ...args: string[]): string[] {
  // `-u`: UTF-8 output without depending on the caller's locale. Without LANG (a launchd service, a
  // Git hook run by a GUI editor) tmux rewrites control characters in format output, and the tab
  // every `-F` line is split on arrives as `_`.
  return m.tmuxSocket ? [m.tmuxBin, '-u', '-L', m.tmuxSocket, ...args] : [m.tmuxBin, '-u', ...args];
}
