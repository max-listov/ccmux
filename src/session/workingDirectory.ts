import { statSync } from 'node:fs';

export function workingDirectoryReason(name: string, dir: string, problem: string): string {
  return `its working directory ${problem}: ${dir} — set one that does with \`ccmux dir ${name} <path>\``;
}

/** A launch cannot recover an invalid cwd; its exact registration waits for an explicit repair. */
export function workingDirectoryIssue(name: string, dir: string): string | null {
  try {
    const entry = statSync(dir, { throwIfNoEntry: false });
    if (entry?.isDirectory()) return null;
    return workingDirectoryReason(name, dir, entry ? 'is not a directory' : 'does not exist');
  } catch (error) {
    return workingDirectoryReason(name, dir, `cannot be inspected (${String(error)})`);
  }
}
