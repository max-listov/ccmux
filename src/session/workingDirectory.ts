import { accessSync, constants, statSync } from 'node:fs';

export function workingDirectoryReason(name: string, dir: string, problem: string): string {
  // `stitchmux dir` only records the new path; the block it explains is cleared by the next start.
  return `its working directory ${problem}: ${dir} — set one that does with \`stitchmux dir ${name} <path>\`, then \`stitchmux start ${name}\``;
}

/**
 * A launch cannot recover an invalid cwd; its exact registration waits for an explicit repair.
 * A directory the agent cannot enter or list blocks like a missing one: spawning into it fails with
 * `EACCES`, and retrying cannot change the answer.
 */
export function workingDirectoryIssue(name: string, dir: string): string | null {
  try {
    const entry = statSync(dir, { throwIfNoEntry: false });
    if (entry === undefined) return workingDirectoryReason(name, dir, 'does not exist');
    if (!entry.isDirectory()) return workingDirectoryReason(name, dir, 'is not a directory');
  } catch (error) {
    return workingDirectoryReason(name, dir, `cannot be inspected (${String(error)})`);
  }
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    return null;
  } catch {
    return workingDirectoryReason(name, dir, 'is not accessible');
  }
}
