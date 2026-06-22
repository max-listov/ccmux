// Boot-loop guard: if a freshly-auto-updated bundle keeps crashing the daemon, the fleet
// box must heal ITSELF — the auto-updater can't fix anything while it's the thing dying.
// Mechanics: the daemon bumps a persistent attempt counter at startup and clears it after
// its first successful ensure pass. Reaching MAX_ATTEMPTS at startup means "this bundle
// never survives long enough to work" → restore APP_BUNDLE from .bak and exit non-zero so
// the boot unit relaunches onto the restored (known-good) bundle.
//
// Load/syntax failures never reach this code — `update` preflights the candidate bundle
// before swapping (see update.ts). This guard catches the rarer runtime crash loop.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.ts";

export const MAX_ATTEMPTS = 3;

function readAttempts(counterFile: string): number {
  try {
    const n = Number.parseInt(readFileSync(counterFile, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Called at daemon startup. Returns "revert" when the boot loop tripped and the bundle
 *  was restored from .bak (caller must exit non-zero → boot unit relaunches old code). */
export function bootGuardStart(counterFile: string, appBundle: string): "ok" | "revert" {
  const attempts = readAttempts(counterFile) + 1;
  try {
    mkdirSync(dirname(counterFile), { recursive: true });
    writeFileSync(counterFile, `${attempts}\n`);
  } catch {
    return "ok"; // guard must never block a normal start
  }
  if (attempts < MAX_ATTEMPTS) return "ok";
  const bak = `${appBundle}.bak`;
  if (!existsSync(bak)) {
    log.error({ msg: "boot-guard tripped but no .bak to revert to — staying on current bundle", attempts });
    clearBootGuard(counterFile); // don't trip forever with no way out
    return "ok";
  }
  try {
    copyFileSync(bak, appBundle);
    clearBootGuard(counterFile);
    log.error({ msg: "boot-guard: daemon crash-looped — reverted bundle from .bak", attempts });
    return "revert";
  } catch (e) {
    log.error({ msg: "boot-guard revert failed", err: String(e) });
    return "ok";
  }
}

/** Called after the daemon's first successful ensure pass — this bundle works. */
export function clearBootGuard(counterFile: string): void {
  rmSync(counterFile, { force: true });
}
