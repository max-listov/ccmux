import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { APP_BUNDLE, LEGACY_APP_BUNDLE, bootArgv } from "./paths.ts";
import { SHIM_PATH } from "../env.ts";
import { atomicWrite } from "../util/atomic.ts";
import { log } from "../util/log.ts";
import { writeBootUnitOnly } from "../boot/install.ts";
import type { MachineConfig } from "../types.ts";

export type BundleMigration = "already" | "moved" | "absent";

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
export function migrateBundleToDurableRoot(appBundle: string = APP_BUNDLE, legacy: string = LEGACY_APP_BUNDLE): BundleMigration {
  if (existsSync(appBundle)) return "already";
  if (!existsSync(legacy)) return "absent";
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
  return "moved";
}

/** The two-line PATH shim, as it should read for the current bundle location. */
export function shimContents(): string {
  const [exec, entry] = bootArgv();
  const target = entry === undefined ? `"${exec}"` : `"${exec}" "${entry}"`;
  return `#!/usr/bin/env bash\nexec ${target} "$@"\n`;
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
  log.info({ msg: "shim rewritten for the durable bundle path", path: SHIM_PATH });
  return true;
}

/**
 * Converge this machine onto the durable bundle location. Safe to call on every invocation: on a
 * machine that is already correct it does two `existsSync` calls and returns. Failures are reported
 * and swallowed — a command must not die because a boot unit could not be rewritten (an unprivileged
 * CLI cannot write one, and that is not this command's problem to solve).
 */
export async function convergeBundleLocation(m: MachineConfig): Promise<BundleMigration> {
  const moved = migrateBundleToDurableRoot();
  if (moved !== "moved") return moved;
  log.info({ msg: "bundle moved out of the cache root", from: LEGACY_APP_BUNDLE, to: APP_BUNDLE });
  try {
    await writeBootUnitOnly(m);
  } catch (e) {
    log.warn({ msg: "bundle moved but the boot unit still points at the old path", err: String(e) });
  }
  try {
    await ensureShim();
  } catch (e) {
    log.warn({ msg: "bundle moved but the PATH shim still points at the old path", err: String(e) });
  }
  return moved;
}
