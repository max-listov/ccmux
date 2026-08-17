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
  console.log(`updated to ${ver}. daemon bounced; sessions pick up new code on next restart (all at once: ccmux restart --all). rollback: ccmux update --rollback`);
  return 0;
}

/** Defeat the CDN edge cache in front of the release manifest.
 *
 *  A `cache-control: no-cache` REQUEST header is not enough — measured, not assumed: minutes after
 *  publishing, the same host fetched 0.9.1 with the header and 0.9.2 with a unique query string, and
 *  every release today first reported "already on latest". The manifest lives behind a redirect from
 *  a `…/latest/download/…` URL, and it is the redirect that the edge holds; a query string makes the
 *  cache key unique and sidesteps it. Without this the whole fleet lags a release behind for as long
 *  as the edge decides to hold, which is precisely what auto-update exists to avoid. */
export function cacheBusted(url: string, nonce: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}ccmux=${nonce}`;
}

async function fetchRelease(url: string): Promise<Release | string> {
  try {
    const resp = await fetch(cacheBusted(url, Date.now()), { headers: { "cache-control": "no-cache" } });
    if (!resp.ok) return `fetch ${url} → HTTP ${resp.status}`;
    return ReleaseSchema.parse(await resp.json());
  } catch (e) {
    return `could not read release info — ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The outcome of an update decision. Pure `decideUpdate` returns one of these; `cmdUpdate` only
 *  EXECUTES it — so `--check` is guaranteed read-only (it can only ever produce a `print`). */
export type UpdateDecision =
  | { kind: "apply-staged" }
  | { kind: "apply-remote" }
  | { kind: "print"; code: number; text: string };

/**
 * Decide what `ccmux update` should do — PURE (no fs, no network, no side effects), so it's fully
 * testable and `--check` can never mutate by construction. Inputs are already-resolved versions:
 * `staged` = the local staged bundle's version ("?" if present-but-unreadable, null if absent),
 * `release` = the fetched release version (null if no releaseUrl / not fetched).
 *
 * Two rules this encodes (the 0.1.17 landmine):
 *  1. `--check` ALWAYS returns a `print` — it never applies anything, staged or remote.
 *  2. A staged bundle only wins if it is NEWER than (or equal to) the running version. A stale/older
 *     or unreadable staged build ("forgotten `bun run stage`") is REFUSED as a downgrade unless
 *     `--force` — it no longer silently downgrades the machine.
 */
export function decideUpdate(i: {
  check: boolean;
  force: boolean;
  current: string;
  staged: string | null;
  release: string | null;
  releaseNotes?: string | undefined;
  hasReleaseUrl: boolean;
  /** Whether the bundle this machine launches from is actually on disk. A version match is not
   *  evidence of a working install: the running process holds its code in memory and keeps
   *  answering long after the file is gone, which is exactly how a wiped cache stayed invisible
   *  until someone typed a command. Absent means repair, whatever the versions say. */
  bundlePresent: boolean;
}): UpdateDecision {
  const stagedPath = STAGED_BUNDLE;
  if (i.staged !== null) {
    // Unreadable ("?") counts as "not newer" — never apply a bundle whose version we can't confirm.
    const notNewer = i.staged === "?" || compareSemver(i.staged, i.current) < 0;
    if (i.check) {
      return {
        kind: "print",
        code: 0,
        text: notNewer
          ? `staged local build ${i.staged} present but NOT newer than current ${i.current} — 'ccmux update' would refuse it as a downgrade (a forgotten 'bun run stage'?). remove: rm ${stagedPath}  ·  or force: ccmux update --force`
          : `staged local build ${i.staged} present — 'ccmux update' would apply it (local test build), NOT the release. remove to track releases again: rm ${stagedPath}`,
      };
    }
    if (notNewer && !i.force) {
      return {
        kind: "print",
        code: 1,
        text: `update: staged local build ${i.staged} is not newer than current ${i.current} — refusing to downgrade (usually a forgotten 'bun run stage'). remove it: rm ${stagedPath}  ·  or force: ccmux update --force`,
      };
    }
    return { kind: "apply-staged" };
  }

  // No staged bundle → the release path.
  if (!i.hasReleaseUrl || i.release === null) {
    return {
      kind: "print",
      code: i.check ? 0 : 1,
      text: "update: nothing staged (no staged/ccmux.js in the cache) and no releaseUrl. Stage one (dev checkout): bun run stage",
    };
  }
  const cmp = compareSemver(i.current, i.release);
  if (!i.bundlePresent && !i.check) return { kind: "apply-remote" };
  if (!i.bundlePresent && i.check) {
    return { kind: "print", code: 0, text: `bundle missing from ${APP_BUNDLE} — 'ccmux update' would restore ${i.release} (the running process is serving from memory)` };
  }
  if (!i.force && cmp >= 0) {
    return {
      kind: "print",
      code: 0,
      text: cmp === 0 ? `already on latest (${i.current})` : `local ${i.current} ahead of release ${i.release}${i.check ? "" : " (--force to override)"}`,
    };
  }
  if (i.check) {
    return { kind: "print", code: 0, text: `update available: ${i.current} → ${i.release}${i.releaseNotes ? ` — ${i.releaseNotes}` : ""}\nrun: ccmux update` };
  }
  return { kind: "apply-remote" };
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

/** Daemon auto-update tick: if releaseUrl has a NEWER version — or if the bundle we launch from has
 *  gone missing — pull+verify+apply (bounce — sessions survive). No-op when nothing newer AND the
 *  install is intact. File-logged; the bounce restarts the daemon.
 *
 *  The missing-file arm is not a nicety. A running daemon serves from memory, so a deleted bundle
 *  changes nothing it can observe about itself while making it unable to ever start again; version
 *  equality then reads as "healthy" for as long as the process happens to live. */
export async function autoUpdateOnce(m: MachineConfig): Promise<void> {
  if (!m.releaseUrl) return;
  const release = await fetchRelease(m.releaseUrl);
  if (typeof release === "string") {
    log.warn({ msg: "auto-update check failed", err: release });
    return;
  }
  const missing = !existsSync(APP_BUNDLE);
  if (!missing && compareSemver(VERSION, release.version) >= 0) {
    log.debug({ msg: "auto-update check: no newer release", local: VERSION, remote: release.version });
    return;
  }
  if (missing) log.warn({ msg: "bundle missing from disk — restoring it", path: APP_BUNDLE, version: release.version });
  else log.info({ msg: "auto-update seen", from: VERSION, to: release.version });
  const err = await downloadVerifyApply(m, release);
  if (err) log.error({ msg: "auto-update failed", to: release.version, err });
  else log.info({ msg: "auto-update applied — daemon bouncing onto new bundle", to: release.version });
}

/**
 * Self-update. A LOCAL staged build wins ONLY if newer (the "test locally first" path); otherwise
 * pull the remote release. `--check` is read-only (reports, never applies — the decision is made by
 * the pure `decideUpdate`, which can only return `print` for a check). A successful apply swaps the
 * prod APP_BUNDLE atomically + bounces the daemon — sessions outlive the bounce, each _run picks up
 * the new code on its next restart.
 */
export async function cmdUpdate(args: string[]): Promise<number> {
  const o = parseOpts(args);
  const m = loadMachineConfig();
  if (o.rollback) return rollback(m);

  // Resolve the two candidate versions (this is the only IO; the DECISION is pure below).
  const stagedPresent = existsSync(STAGED_BUNDLE);
  const staged = stagedPresent ? await bundleVersion(STAGED_BUNDLE) : null;
  let release: Release | null = null;
  if (!stagedPresent && m.releaseUrl !== undefined) {
    const r = await fetchRelease(m.releaseUrl);
    if (typeof r === "string") {
      console.log(`update: ${r}`);
      return 1;
    }
    release = r;
  }

  const decision = decideUpdate({
    check: o.check,
    force: o.force,
    current: VERSION,
    staged,
    release: release?.version ?? null,
    releaseNotes: release?.notes,
    hasReleaseUrl: m.releaseUrl !== undefined,
    bundlePresent: existsSync(APP_BUNDLE),
  });

  switch (decision.kind) {
    case "print":
      console.log(decision.text);
      return decision.code;
    case "apply-staged":
      return applyLocal(m);
    case "apply-remote": {
      if (release === null) {
        console.log("update: internal — apply-remote with no release resolved");
        return 1;
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
  }
}
