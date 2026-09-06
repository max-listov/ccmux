import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { convergeBootUnit, writeBootUnitOnly } from '../boot/install.ts';
import { IS_DEV, SHIM_PATH } from '../env.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { log } from '../util/log.ts';
import {
  APP_BUNDLE,
  bootArgv,
  DATA_DIR,
  DEFAULT_DATA_DIR,
  LEGACY_APP_BUNDLE,
  STATUS_LINE_APP,
} from './paths.ts';
import { ensureStatusLineApp } from './statusLineInstall.ts';

export type BundleMigration = 'already' | 'moved' | 'absent';

/**
 * Copy the running bundle into the durable root, out of the cache where a legitimate `rm -rf
 * ~/.cache/*` could take the tool's own recovery path with it. Copy rather than rename: the two
 * roots can sit on different filesystems, where rename fails outright. Copying a file this process
 * is executing is safe — the running image is the open inode, not the name.
 *
 * The old copy is deliberately LEFT BEHIND. A boot manager does not necessarily re-read its unit the
 * moment we rewrite it — launchd serves the definition it loaded until the job is re-bootstrapped or
 * the machine reboots — so deleting the path it still believes in would open a window where a daemon
 * that died could not come back. The stale copy costs a couple of megabytes in a directory that is
 * safe to wipe, and `install.sh` removes it once the machine is fully converged.
 */
export function migrateBundleToDurableRoot(
  appBundle: string = APP_BUNDLE,
  legacy: string = LEGACY_APP_BUNDLE,
): BundleMigration {
  if (existsSync(appBundle)) return 'already';
  if (!existsSync(legacy)) return 'absent';
  mkdirSync(dirname(appBundle), { recursive: true });
  copyFileSync(legacy, appBundle);
  // The rollback copy is the boot guard's only way out of a crash loop; leaving it in the
  // directory we are abandoning would re-create the failure this whole move exists to prevent.
  if (existsSync(`${legacy}.bak`)) {
    try {
      copyFileSync(`${legacy}.bak`, `${appBundle}.bak`);
    } catch {
      /* best-effort: a missing rollback copy is not worth failing the move over */
    }
  }
  return 'moved';
}

/**
 * The PATH shim, as it should read for the current bundle location.
 *
 * One verb is routed past the bundle. `status-line` is run by Claude Code on every refresh of every
 * managed session and it is injected as `ccmux status-line` — through this file — so teaching the
 * shim is what makes the compiled program reach every session at once, with no session's settings
 * rewritten and nothing to migrate. The guard is the rollback: no artifact, and the bundle answers
 * the same verb, slower and correctly. A compiled single-file build has no separate bundle to skip,
 * so it keeps the plain two-line form.
 *
 * `scripts/install.sh` writes this same file before any of this code can run, and the two are
 * compared in the test suite: two writers that disagree would rewrite each other on every daemon
 * start, forever.
 */
export function shimContents(): string {
  const [exec, entry] = bootArgv();
  if (entry === undefined) return `#!/bin/sh\nexec "${exec}" "$@"\n`;
  // Beside the bundle this shim actually names, not beside the one an installed machine would have:
  // a file that routes somewhere must not hold two different opinions about where it points.
  const program = join(dirname(entry), 'status-line.js');
  return (
    `#!/bin/sh\n` +
    `if [ "$1" = "status-line" ] && [ -r "${program}" ]; then\n` +
    `  exec "${exec}" "${program}" "$@"\n` +
    `fi\n` +
    `exec "${exec}" "${entry}" "$@"\n`
  );
}

/** Rewrite the shim only when it does not already say the right thing. Convergent on purpose: a
 *  machine that is already correct must come out of this untouched. */
export async function ensureShim(): Promise<boolean> {
  const want = shimContents();
  if (existsSync(SHIM_PATH)) {
    try {
      if ((await Bun.file(SHIM_PATH).text()) === want) return false;
    } catch {
      /* unreadable → rewrite it */
    }
  }
  mkdirSync(dirname(SHIM_PATH), { recursive: true });
  await atomicWrite(SHIM_PATH, want, 0o755);
  log.info({ msg: 'shim rewritten for the durable bundle path', path: SHIM_PATH });
  return true;
}

/** The fixed user-facing shim belongs only to the default installation. Release sandboxes and
 * isolated instances carry their own data root and must never repoint that shared command. */
export function ownsInstalledShim(dataDir: string = DATA_DIR, isDev: boolean = IS_DEV): boolean {
  return !isDev && dataDir === DEFAULT_DATA_DIR;
}

/**
 * Converge this machine onto the durable bundle location. Safe to call on every invocation: on a
 * machine that is already correct it does two `existsSync` calls and returns. Failures are reported
 * and swallowed — a command must not die because a boot unit could not be rewritten (an unprivileged
 * CLI cannot write one, and that is not this command's problem to solve).
 */
export async function convergeBundleLocation(m: MachineConfig): Promise<BundleMigration> {
  const moved = migrateBundleToDurableRoot();
  if (moved === 'moved') {
    log.info({
      msg: 'bundle moved out of the cache root',
      from: LEGACY_APP_BUNDLE,
      to: APP_BUNDLE,
    });
    try {
      await writeBootUnitOnly(m);
    } catch (e) {
      log.warn({
        msg: 'bundle moved but the boot unit still points at the old path',
        err: String(e),
      });
    }
  }
  // Every installed daemon start converges the executable contract too. This upgrades an existing
  // env-based shim after an ordinary bundle rollout; source/dev daemons must never rewrite the
  // operator's installed command to point into a checkout.
  if (ownsInstalledShim() && moved !== 'absent') {
    // The program the shim routes to is laid down FIRST. In the other order a machine would carry a
    // shim naming a file that is not there yet — harmless, because the guard falls back to the
    // bundle, but it would mean the win arrives a daemon start later than the risk.
    try {
      const status = await ensureStatusLineApp();
      if (status === 'written')
        log.info({ msg: 'status-line program written', path: STATUS_LINE_APP });
    } catch (e) {
      log.warn({ msg: 'status-line program could not be written', err: String(e) });
    }
    try {
      await ensureShim();
    } catch (e) {
      log.warn({ msg: 'installed PATH shim could not be converged', err: String(e) });
    }
  }
  // And the boot unit, for the same reason and on the same terms. A release rolls out code; without
  // this it never rolls out the definition that decides whether the daemon comes back at all, so a
  // fix to the restart policy would ship to every machine and take effect on none.
  try {
    await convergeBootUnit(m);
  } catch (e) {
    log.warn({ msg: 'boot unit could not be converged to this version', err: String(e) });
  }
  return moved;
}
