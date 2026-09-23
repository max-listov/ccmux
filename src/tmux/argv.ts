import type { MachineConfig } from '../types.ts';

/** Base tmux argv, scoped to the config's optional dedicated socket (`-L`). EVERY tmux invocation
 *  goes through this, so an isolated instance (dev) is fully confined to its own tmux server. Unset
 *  socket → the default socket (prod), i.e. current behaviour. Exported for the test. */
export function tmuxArgv(m: MachineConfig, ...args: string[]): string[] {
  return m.tmuxSocket ? [m.tmuxBin, '-L', m.tmuxSocket, ...args] : [m.tmuxBin, ...args];
}
