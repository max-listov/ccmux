import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { loadMachineConfig } from "../config/machine.ts";
import { ReleaseSchema } from "../config/schema.ts";
import { VERSION, compareSemver } from "../util/version.ts";
import { restartBoot } from "../boot/install.ts";
import { APP_BUNDLE, STAGED_BUNDLE } from "../config/paths.ts";
import { log } from "../util/log.ts";
import type { MachineConfig, Release } from "../types.ts";

type UpdateOpts = { check: boolean; force: boolean; rollback: boolean };

function parseOpts(args: string[]): UpdateOpts {
  return {
    check: args.includes("--check"),
    force: args.includes("--force"),
    rollback: args.includes("--rollback"),
  };
}

/** Run a bundle's `version` to read what we're about to install (for nice 0.0.1→0.0.2 logs).
 *  Spawns bun by ABSOLUTE path (`process.execPath`), never bare "bun": the daemon runs under
 *  launchd/systemd with a restricted PATH that does NOT include ~/.bun/bin, so bare "bun" is "not
 *  found" → empty output → preflight reads version "?" → every auto-update aborts. This is the
 *  whole self-update feature; it must not depend on PATH. stderr is surfaced on failure so a future
 *  breakage isn't silently swallowed (the original bug hid here for exactly that reason). */
async function bundleVersion(path: string): Promise<string> {
  try {
    const proc = Bun.spawn([process.execPath, path, "version"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const version = out.trim().replace(/^ccmux\s+/, "");
    if (version === "" && (code !== 0 || err.trim() !== "")) {
      log.warn({ msg: "bundleVersion: candidate failed to report version", path, code, stderr: err.trim().slice(0, 300) });
    }
    return version || "?";
  } catch (e) {
    log.warn({ msg: "bundleVersion: spawn failed", path, err: String(e) });
    return "?";
  }
}

/** Atomic swap into APP_BUNDLE: backup current → move/copy new over. The running daemon
 *  keeps the old (now-unlinked) inode; restartBoot relaunches it on the new file. */
async function swapAndBounce(m: MachineConfig, from: string, move: boolean): Promise<void> {
  mkdirSync(dirname(APP_BUNDLE), { recursive: true });
  if (existsSync(APP_BUNDLE)) {
    try {
      copyFileSync(APP_BUNDLE, `${APP_BUNDLE}.bak`);
    } catch {
      /* best-effort backup */
    }
  }
  if (move) renameSync(from, APP_BUNDLE);
  else copyFileSync(from, APP_BUNDLE);
  await restartBoot(m);
}

async function rollback(m: MachineConfig): Promise<number> {
  const bak = `${APP_BUNDLE}.bak`;
  if (!existsSync(bak)) {
    console.log("update: no backup (.bak) to roll back to");
    return 1;
  }
  copyFileSync(bak, APP_BUNDLE);
  await restartBoot(m);
  log.info({ msg: "update: rolled back to .bak bundle" });
  console.log("rolled back to previous bundle; daemon bounced (sessions keep running).");
  return 0;
}

async function applyLocal(m: MachineConfig): Promise<number> {
  const ver = await bundleVersion(STAGED_BUNDLE);
  console.log(`updating ${VERSION} → ${ver} (local staged build)…`);
  log.info({ msg: "update: applying local staged build", from: VERSION, to: ver });
  await swapAndBounce(m, STAGED_BUNDLE, true); // move → staged is consumed
  rmSync(STAGED_BUNDLE, { force: true });
  console.log(`updated to ${ver}. daemon bounced; sessions pick up new code on next restart. rollback: ccmux update --rollback`);
  return 0;
}

async function fetchRelease(url: string): Promise<Release | string> {
  try {
    const resp = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (!resp.ok) return `fetch ${url} → HTTP ${resp.status}`;
    return ReleaseSchema.parse(await resp.json());
  } catch (e) {
    return `could not read release info — ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function applyRemote(m: MachineConfig, o: UpdateOpts): Promise<number> {
  if (m.releaseUrl === undefined) {
    console.log("update: nothing staged (~/.ccmux/staged/ccmux.js) and no releaseUrl. Stage one (dev checkout): bun run stage");
    return 1;
  }
  const release = await fetchRelease(m.releaseUrl);
  if (typeof release === "string") {
    console.log(`update: ${release}`);
    return 1;
  }
  const cmp = compareSemver(VERSION, release.version);
  if (!o.force && cmp >= 0) {
    console.log(cmp === 0 ? `already on latest (${VERSION})` : `local ${VERSION} ahead of release ${release.version} (--force to override)`);
    return 0;
  }
  if (o.check) {
    console.log(`update available: ${VERSION} → ${release.version}${release.notes ? ` — ${release.notes}` : ""}`);
    console.log("run: ccmux update");
    return 0;
  }
  console.log(`updating ${VERSION} → ${release.version}…`);
  log.info({ msg: "update: applying remote release", from: VERSION, to: release.version });
  const err = await downloadVerifyApply(m, release);
  if (err) {
    log.error({ msg: "update failed", to: release.version, err });
    console.log(`update: ${err}`);
    return 1;
  }
  console.log(`updated to ${release.version}. daemon bounced; sessions keep running. rollback: ccmux update --rollback`);
  return 0;
}

/** Load-test a candidate bundle BEFORE it replaces the live one: `bun candidate version`
 *  must exit cleanly and print the expected version. Catches the deadliest failure class
 *  (bundle that won't even parse/load → daemon dead → auto-updater dead with it).
 *  Exported for the test. */
export async function preflightBundle(path: string, expectedVersion: string): Promise<string | null> {
  const got = await bundleVersion(path);
  if (got === expectedVersion) return null;
  return `preflight failed — candidate bundle reports version "${got}", expected "${expectedVersion}". ABORTED (live bundle untouched)`;
}

/** Download the release bytes, verify sha256 + preflight BEFORE touching the live binary,
 *  then atomic-swap + bounce. Returns null on success, or an error string. Shared by
 *  manual + auto update. */
async function downloadVerifyApply(m: MachineConfig, release: Release): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    const resp = await fetch(release.url);
    if (!resp.ok) return `download → HTTP ${resp.status}`;
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    return `download failed — ${e instanceof Error ? e.message : String(e)}`;
  }
  const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (got !== release.sha256) return `checksum mismatch — expected ${release.sha256}, got ${got}. ABORTED`;
  const tmp = `${APP_BUNDLE}.tmp-${process.pid}`;
  mkdirSync(dirname(APP_BUNDLE), { recursive: true });
  await Bun.write(tmp, bytes);
  const bad = await preflightBundle(tmp, release.version);
  if (bad) {
    rmSync(tmp, { force: true });
    return bad;
  }
  await swapAndBounce(m, tmp, true);
  return null;
}

/** Daemon auto-update tick: if releaseUrl has a NEWER version, pull+verify+apply (bounce —
 *  sessions survive). No-op when nothing newer. File-logged; the bounce restarts the daemon. */
export async function autoUpdateOnce(m: MachineConfig): Promise<void> {
  if (!m.releaseUrl) return;
  const release = await fetchRelease(m.releaseUrl);
  if (typeof release === "string") {
    log.warn({ msg: "auto-update check failed", err: release });
    return;
  }
  if (compareSemver(VERSION, release.version) >= 0) {
    log.debug({ msg: "auto-update check: no newer release", local: VERSION, remote: release.version });
    return;
  }
  log.info({ msg: "auto-update seen", from: VERSION, to: release.version });
  const err = await downloadVerifyApply(m, release);
  if (err) log.error({ msg: "auto-update failed", to: release.version, err });
  else log.info({ msg: "auto-update applied — daemon bouncing onto new bundle", to: release.version });
}

/**
 * Self-update. A LOCAL staged build wins (the "test locally first" path); otherwise pull
 * the remote release. Always swaps the prod APP_BUNDLE atomically + bounces the daemon —
 * sessions outlive the bounce, each _run picks up the new code on its next restart.
 */
export async function cmdUpdate(args: string[]): Promise<number> {
  const o = parseOpts(args);
  const m = loadMachineConfig();
  if (o.rollback) return rollback(m);
  if (existsSync(STAGED_BUNDLE)) return applyLocal(m);
  return applyRemote(m, o);
}
