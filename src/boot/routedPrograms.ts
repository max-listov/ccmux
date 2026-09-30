/**
 * Verbs the PATH shim runs past the bundle, each as its own small program beside it.
 *
 * Bun parses the whole CLI bundle before a command's first line runs; for a verb that runs
 * constantly and does little, that parse is most of what it costs. `status-line` runs on every
 * refresh of every managed session; `_peer-read` answers every fleet read another machine makes.
 * Each is compiled on its own from the same source as its verb (`entry`), carried inside the bundle
 * and laid down beside it (`routedInstall.ts`), and the shim sends the verb to it. One table, so the
 * shim, the installer's shim, the build and the install cannot disagree about which verbs are routed.
 */
export interface RoutedProgram {
  verb: string;
  args?: readonly string[];
  file: string;
  entry: string;
}
export const ROUTED_PROGRAMS: readonly RoutedProgram[] = [
  { verb: 'status-line', file: 'status-line.js', entry: 'src/commands/statusLineEntry.ts' },
  { verb: '_peer-read', file: 'peer-read.js', entry: 'src/commands/peerReadEntry.ts' },
  {
    verb: 'control',
    args: ['external', '--json'],
    file: 'control-external.js',
    entry: 'src/commands/controlExternalEntry.ts',
  },
];
