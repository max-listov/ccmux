type Child = ReturnType<typeof Bun.spawn>;

export function ownedChildAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    // A denied zero-signal probe is not absence. Keep bounded cleanup active; actual
    // SIGTERM/SIGKILL permission failures must still propagate through signalGroup.
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(group, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

/** The detached provider group includes a package-manager launcher and its native child.
 * Killing only the launcher can leave a writer holding both the socket and stderr open. */
export async function stopOwnedChildGroup(child: Child): Promise<void> {
  const group = -child.pid;
  signalGroup(group, 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (ownedChildAlive(group) && Date.now() < deadline) await Bun.sleep(25);
  signalGroup(group, 'SIGKILL');
  await child.exited;
}
