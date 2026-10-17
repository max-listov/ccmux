import { SELF_ARGV } from '../util/env.ts';
import { fileStamp } from '../util/fileStamp.ts';

/**
 * Whether the code a `_run` supervisor is running is still the code installed on this machine.
 *
 * A supervisor outlives updates: the process keeps the bundle it loaded, so after an update a session
 * would still be judged by the previous version's rules, and a refusal it writes is final. It asks
 * this before judging and leaves when the answer is yes.
 */

/** The deployed bundle this process was loaded from; null when running from sources (dev), where a
 *  file changing on disk is an edit and not an update. */
function bundleStamp(): string | null {
  const entry = SELF_ARGV[SELF_ARGV.length - 1];
  if (entry === undefined || entry.endsWith('.ts')) return null;
  try {
    return fileStamp(entry, { ctime: false });
  } catch {
    // An unreadable bundle is not evidence of a new one.
    return null;
  }
}

/** Taken while this module loads, which is when the process reads its bundle. */
const LOADED = bundleStamp();

/** Pure: the installed bundle differs from the loaded one. A bundle that is missing at this instant
 *  (an update replacing the file) or unknown is never "different" — the next check will see it. */
export function installedCodeDiffers(loaded: string | null, installed: string | null): boolean {
  return (
    loaded !== null &&
    loaded !== 'missing' &&
    installed !== null &&
    installed !== 'missing' &&
    loaded !== installed
  );
}

/** True when this process is running code older than what is installed. */
export function supervisorIsStale(): boolean {
  return installedCodeDiffers(LOADED, bundleStamp());
}
