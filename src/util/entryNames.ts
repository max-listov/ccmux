import { readdirSync } from 'node:fs';

/** The names in a directory; none when it cannot be read — a directory that is not there holds
 *  nothing, and the caller's answer for "nothing" is the right one. */
export function entryNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
