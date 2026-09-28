// Boot-loop guard: if a freshly-auto-updated bundle keeps crashing the daemon, the fleet
// box must heal ITSELF — the auto-updater can't fix anything while it's the thing dying.
// Mechanics: the daemon bumps a persistent attempt counter at startup and clears it after
// its first successful ensure pass. Reaching MAX_ATTEMPTS at startup means "this bundle
// never survives long enough to work" → restore APP_BUNDLE from .bak and exit non-zero so
// the boot unit relaunches onto the restored (known-good) bundle.
//
// Load/syntax failures never reach this code — `update` preflights the candidate bundle
// before swapping (see update.ts). This guard catches the rarer runtime crash loop.
//
// A crash loop is the bundle's fault only while the bundle has never worked here. The first
// successful pass records the running bundle's digest as proven; a loop on a proven bundle is the
// machine's — a lock a crash left behind, a full disk, a dependency down — and swapping the bundle
// would not cure it, only replace working code with older code. That loop is left to the
// supervisor's restarts, which keep retrying until the cause clears.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomicSync } from 'stitchkit/files';
import { copyFileAtomic } from './atomic.ts';
import { log } from './log.ts';

export const MAX_ATTEMPTS = 3;

function readAttempts(counterFile: string): number {
  try {
    const n = Number.parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Called at daemon startup. Returns "revert" when the boot loop tripped and the bundle
 *  was restored from .bak (caller must exit non-zero → boot unit relaunches old code). */
const provenPath = (counterFile: string) => `${counterFile}.proven`;
function digestOf(path: string): string | null {
  try {
    return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}
function readProven(counterFile: string): string | null {
  try {
    return readFileSync(provenPath(counterFile), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
/** The digest of the bundle this process started from, recorded as proven by its first good pass. */
let startedDigest: string | null = null;

export function bootGuardStart(counterFile: string, appBundle: string): 'ok' | 'revert' {
  startedDigest = digestOf(appBundle);
  const attempts = readAttempts(counterFile) + 1;
  try {
    mkdirSync(dirname(counterFile), { recursive: true });
    writeFileSync(counterFile, `${attempts}\n`);
  } catch {
    return 'ok'; // guard must never block a normal start
  }
  if (attempts < MAX_ATTEMPTS) return 'ok';
  if (startedDigest !== null && startedDigest === readProven(counterFile)) {
    log.error({
      msg: 'boot-guard: daemon crash-looped on a bundle that has run here — not reverting; the cause is outside the bundle',
      attempts,
    });
    clearBootGuard(counterFile);
    return 'ok';
  }
  const bak = `${appBundle}.bak`;
  if (!existsSync(bak)) {
    log.error({
      msg: 'boot-guard tripped but no .bak to revert to — staying on current bundle',
      attempts,
    });
    clearBootGuard(counterFile); // don't trip forever with no way out
    return 'ok';
  }
  try {
    copyFileAtomic(bak, appBundle);
    clearBootGuard(counterFile);
    log.error({ msg: 'boot-guard: daemon crash-looped — reverted bundle from .bak', attempts });
    return 'revert';
  } catch (e) {
    log.error({ msg: 'boot-guard revert failed', err: String(e) });
    return 'ok';
  }
}

/** Called after the daemon's first successful ensure pass — this bundle works. */
export function clearBootGuard(counterFile: string): void {
  rmSync(counterFile, { force: true });
}

/** Called once per daemon run after its first successful ensure pass: the bundle it started from
 * works on this machine, so a later crash loop on the same bytes is not the bundle's. */
export function proveBootBundle(counterFile: string): void {
  clearBootGuard(counterFile);
  if (startedDigest === null) return;
  try {
    writeFileAtomicSync(provenPath(counterFile), `${startedDigest}\n`);
  } catch (error) {
    log.error({ msg: 'boot-guard: could not record the proven bundle', err: String(error) });
  }
}
