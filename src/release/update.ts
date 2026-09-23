import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  applyCliUpdate,
  type CliBuildManifest,
  CliBuildManifestSchema,
  type CliTrustRoot,
  cliSignatureAccepted,
  rollbackCliUpdate,
  selectCliBuildAsset,
  verifyCliManifest,
} from 'stitchkit/cli';
import { restartBoot } from '../boot/install.ts';
import { ReleaseSchema } from '../config/machineSchema.ts';
import { APP_BUNDLE, STAGED_BUNDLE } from '../config/paths.ts';
import type { MachineConfig, Release } from '../types.ts';
import { atomicWrite, copyFileAtomic } from '../util/atomic.ts';
import { withLock } from '../util/lock.ts';
import { log } from '../util/log.ts';
import { compareSemver, VERSION } from '../util/version.ts';
import { recordReleaseCheck } from './check.ts';
import { releaseTrust } from './trust.ts';

/** Run a bundle's `version` to read what we're about to install (for nice 0.0.1→0.0.2 logs).
 *  Spawns bun by ABSOLUTE path (`process.execPath`), never bare "bun": the daemon runs under
 *  launchd/systemd with a restricted PATH that does NOT include ~/.bun/bin, so bare "bun" is "not
 *  found" → empty output → preflight reads version "?" → every auto-update aborts. This is the
 *  whole self-update feature; it must not depend on PATH. stderr is surfaced on failure so a future
 *  breakage isn't silently swallowed (the original bug hid here for exactly that reason). */
export async function bundleVersion(path: string): Promise<string> {
  try {
    const proc = Bun.spawn([process.execPath, path, 'version'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const version = out.trim().replace(/^ccmux\s+/, '');
    if (version === '' && (code !== 0 || err.trim() !== '')) {
      log.warn({
        msg: 'bundleVersion: candidate failed to report version',
        path,
        code,
        stderr: err.trim().slice(0, 300),
      });
    }
    return version || '?';
  } catch (e) {
    log.warn({ msg: 'bundleVersion: spawn failed', path, err: String(e) });
    return '?';
  }
}

/** The digest of the bytes in `${target}.bak`, recorded whenever a backup is taken, so a rollback
 *  installs exactly what was replaced and refuses a corrupted or swapped backup. */
function backupDigestPath(target: string): string {
  return `${target}.bak.sha256`;
}

function sha256Of(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function updateLock<T>(target: string, run: () => Promise<T>): Promise<T> {
  return withLock(`${target}.update-lock`, run, 'bundle update');
}

/** Serialize manual/automatic swaps and preserve the predecessor on duplicate installs. `from` is
 *  consumed: it is renamed over `target`, which the running daemon keeps as its unlinked inode. */
export async function replaceBundle(from: string, target: string): Promise<void> {
  await updateLock(target, async () => {
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const current = readFileSync(target);
      if (current.equals(readFileSync(from))) {
        if (from !== target) rmSync(from);
        return;
      }
      // A failed backup aborts the swap; a claimed rollback must contain the actual predecessor.
      copyFileAtomic(target, `${target}.bak`);
      await atomicWrite(backupDigestPath(target), sha256Of(current));
    }
    renameSync(from, target);
  });
}

/** Put `${target}.bak` back over `target`, whole or not at all, and only if it is the backup that
 *  was taken. A backup taken by a ccmux older than its recorded digest has none: it is restored as
 *  it is, and that branch ends once every machine has been updated by a version that records it. */
export async function restoreBackup(target: string): Promise<boolean> {
  const bak = `${target}.bak`;
  if (!existsSync(bak)) return false;
  await updateLock(target, async () => {
    const digest = backupDigestPath(target);
    if (!existsSync(digest)) {
      log.warn({ msg: 'update: backup has no recorded digest — restoring it unverified', bak });
      copyFileAtomic(bak, target);
      return;
    }
    rollbackCliUpdate({
      targetPath: target,
      backupPath: bak,
      expectedSha256: readFileSync(digest, 'utf8').trim(),
    });
  });
  return true;
}

export async function rollback(m: MachineConfig): Promise<number> {
  if (!(await restoreBackup(APP_BUNDLE))) {
    console.log('update: no backup (.bak) to roll back to');
    return 1;
  }
  await restartBoot(m);
  log.info({ msg: 'update: rolled back to .bak bundle' });
  console.log('rolled back to previous bundle; daemon bounced (sessions keep running).');
  return 0;
}

export async function applyLocal(m: MachineConfig): Promise<number> {
  const ver = await bundleVersion(STAGED_BUNDLE);
  console.log(`updating ${VERSION} → ${ver} (local staged build)…`);
  log.info({ msg: 'update: applying local staged build', from: VERSION, to: ver });
  await replaceBundle(STAGED_BUNDLE, APP_BUNDLE); // the staged build is consumed
  await restartBoot(m);
  console.log(
    `updated to ${ver}. daemon bounced; sessions pick up new code on next restart (all at once: ccmux restart --all). rollback: ccmux update --rollback`,
  );
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
  return `${url}${url.includes('?') ? '&' : '?'}ccmux=${nonce}`;
}

/** A release as published: the fields every ccmux reads, and the signed build manifest the same
 *  document is — `null` for a release published before ccmux signed them. */
export type FetchedRelease = Release & { manifest: CliBuildManifest | null };

export async function fetchRelease(url: string): Promise<FetchedRelease | string> {
  try {
    const resp = await fetch(cacheBusted(url, Date.now()), {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!resp.ok) return `fetch ${url} → HTTP ${resp.status}`;
    const document: unknown = await resp.json();
    return {
      ...ReleaseSchema.parse(document),
      manifest: CliBuildManifestSchema.safeParse(document).data ?? null,
    };
  } catch (e) {
    return `could not read release info — ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The outcome of an update decision. Pure `decideUpdate` returns one of these; `cmdUpdate` only
 *  EXECUTES it — so `--check` is guaranteed read-only (it can only ever produce a `print`). */
export type UpdateDecision =
  | { kind: 'apply-staged' }
  | { kind: 'apply-remote' }
  | { kind: 'print'; code: number; text: string };

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
    const notNewer = i.staged === '?' || compareSemver(i.staged, i.current) < 0;
    if (i.check) {
      return {
        kind: 'print',
        code: 0,
        text: notNewer
          ? `staged local build ${i.staged} present but NOT newer than current ${i.current} — 'ccmux update' would refuse it as a downgrade (a forgotten 'bun run stage'?). remove: rm ${stagedPath}  ·  or force: ccmux update --force`
          : `staged local build ${i.staged} present — 'ccmux update' would apply it (local test build), NOT the release. remove to track releases again: rm ${stagedPath}`,
      };
    }
    if (notNewer && !i.force) {
      return {
        kind: 'print',
        code: 1,
        text: `update: staged local build ${i.staged} is not newer than current ${i.current} — refusing to downgrade (usually a forgotten 'bun run stage'). remove it: rm ${stagedPath}  ·  or force: ccmux update --force`,
      };
    }
    return { kind: 'apply-staged' };
  }

  // No staged bundle → the release path.
  if (!i.hasReleaseUrl || i.release === null) {
    return {
      kind: 'print',
      code: i.check ? 0 : 1,
      text: 'update: nothing staged (no staged/ccmux.js in the cache) and no releaseUrl. Stage one (dev checkout): bun run stage',
    };
  }
  const cmp = compareSemver(i.current, i.release);
  if (!i.bundlePresent && !i.check) return { kind: 'apply-remote' };
  if (!i.bundlePresent && i.check) {
    return {
      kind: 'print',
      code: 0,
      text: `bundle missing from ${APP_BUNDLE} — 'ccmux update' would restore ${i.release} (the running process is serving from memory)`,
    };
  }
  if (!i.force && cmp >= 0) {
    return {
      kind: 'print',
      code: 0,
      text:
        cmp === 0
          ? `already on latest (${i.current})`
          : `local ${i.current} ahead of release ${i.release}${i.check ? '' : ' (--force to override)'}`,
    };
  }
  if (i.check) {
    return {
      kind: 'print',
      code: 0,
      text: `update available: ${i.current} → ${i.release}${i.releaseNotes ? ` — ${i.releaseNotes}` : ''}\nrun: ccmux update`,
    };
  }
  return { kind: 'apply-remote' };
}

/** Load-test a candidate bundle BEFORE it replaces the live one: `bun candidate version`
 *  must exit cleanly and print the expected version. Catches the deadliest failure class
 *  (bundle that won't even parse/load → daemon dead → auto-updater dead with it).
 *  Exported for the test. */
export async function preflightBundle(
  path: string,
  expectedVersion: string,
): Promise<string | null> {
  const got = await bundleVersion(path);
  if (got === expectedVersion) return null;
  return `preflight failed — candidate bundle reports version "${got}", expected "${expectedVersion}". ABORTED (live bundle untouched)`;
}

/** The largest bundle an update will download; the real one is a few megabytes. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Download, verify and install a release through stitchkit's `applyCliUpdate`: the manifest's
 *  signature checked against the keys compiled into this ccmux BEFORE anything is fetched, size and
 *  time bounds, the SSRF boundary, the digest over the bytes that will run, a backup with its
 *  digest, and — before anything is replaced — the candidate started with `bun <candidate>
 *  version`, which must report the release's version. A bundle that does not load never replaces
 *  the live one, so the daemon that updates itself is never taken down by its own update. Returns
 *  null on success, or an error string. Shared by manual + auto update. */
export async function downloadVerifyApply(
  m: MachineConfig,
  release: FetchedRelease,
  options: { bounce?: boolean; allowPrivateHosts?: boolean; trust?: CliTrustRoot } = {},
): Promise<string | null> {
  const { manifest } = release;
  if (manifest === null) return `release ${release.version} is not a signed build manifest`;
  if (manifest.version !== release.version)
    return `release ${release.version} carries a manifest for ${manifest.version}`;
  const trust = options.trust ?? releaseTrust(m);
  const verdict = verifyCliManifest(manifest, manifest.signature, trust);
  if (!cliSignatureAccepted(verdict))
    return `release ${release.version} refused — signature ${verdict}`;
  const asset = selectCliBuildAsset(manifest);
  if (asset === undefined)
    return `release ${release.version} has no build for ${process.platform}/${process.arch}`;
  try {
    await updateLock(APP_BUNDLE, async () => {
      mkdirSync(dirname(APP_BUNDLE), { recursive: true });
      // Reinstalling what is already installed would overwrite the backup with the live bundle and
      // lose the actual predecessor.
      if (existsSync(APP_BUNDLE) && sha256Of(readFileSync(APP_BUNDLE)) === asset.sha256) return;
      const applied = await applyCliUpdate({
        asset,
        manifest,
        trust,
        targetPath: APP_BUNDLE,
        backupPath: `${APP_BUNDLE}.bak`,
        maxBytes: MAX_BUNDLE_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(options.allowPrivateHosts === true || m.releaseAllowPrivateHosts === true
          ? { allowPrivateHosts: true }
          : {}),
        verify: async (candidate) => {
          const bad = await preflightBundle(candidate, release.version);
          if (bad) throw new Error(bad);
        },
      });
      if (applied.backupSha256 !== undefined)
        await atomicWrite(backupDigestPath(APP_BUNDLE), applied.backupSha256);
    });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? ` — ${e.cause.message}` : '';
    return `${e instanceof Error ? e.message : String(e)}${cause}`;
  }
  if (options.bounce !== false) await restartBoot(m);
  return null;
}

/** Daemon auto-update tick: verify/install and return whether a restart is needed.
 *  Never await a service-manager restart from inside the daemon being stopped: its managed
 *  schedule must settle before shutdown can drain. The caller requests normal process shutdown.
 *
 *  The missing-file arm is not a nicety. A running daemon serves from memory, so a deleted bundle
 *  changes nothing it can observe about itself while making it unable to ever start again; version
 *  equality then reads as "healthy" for as long as the process happens to live. */
export async function autoUpdateOnce(m: MachineConfig): Promise<boolean> {
  if (!m.releaseUrl) return false;
  const release = await fetchRelease(m.releaseUrl);
  // Written down whether or not it succeeded, and BEFORE acting on it. This is the only place in the
  // system that looks at "what should be running" from the machine itself, and a fleet view needs
  // the failed attempt as much as the successful one: a machine that cannot reach the release feed
  // has not fallen behind, it has stopped being able to say.
  await recordReleaseCheck(
    m,
    typeof release === 'string' ? null : release,
    new Date().toISOString(),
  );
  if (typeof release === 'string') {
    log.warn({ msg: 'auto-update check failed', err: release });
    return false;
  }
  const missing = !existsSync(APP_BUNDLE);
  if (!missing && compareSemver(VERSION, release.version) >= 0) {
    log.debug({
      msg: 'auto-update check: no newer release',
      local: VERSION,
      remote: release.version,
    });
    return false;
  }
  if (missing)
    log.warn({
      msg: 'bundle missing from disk — restoring it',
      path: APP_BUNDLE,
      version: release.version,
    });
  else log.info({ msg: 'auto-update seen', from: VERSION, to: release.version });
  const err = await downloadVerifyApply(m, release, { bounce: false });
  if (err) log.error({ msg: 'auto-update failed', to: release.version, err });
  else log.info({ msg: 'auto-update applied — daemon restart requested', to: release.version });
  return err === null;
}

/**
 * Self-update. A LOCAL staged build wins ONLY if newer (the "test locally first" path); otherwise
 * pull the remote release. `--check` is read-only (reports, never applies — the decision is made by
 * the pure `decideUpdate`, which can only return `print` for a check). A successful apply swaps the
 * prod APP_BUNDLE atomically + bounces the daemon — sessions outlive the bounce, each _run picks up
 * the new code on its next restart.
 */
