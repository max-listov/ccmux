import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, DEFAULT_DATA_DIR, NATIVE_BACKEND_DIR } from '../config/paths.ts';
import { PREVIOUS_COMMAND } from '../migration/renameFromCcmux.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { bootArgv, IS_DEV, SHIM_PATH } from '../util/env.ts';
import { log } from '../util/log.ts';
import { convergeBootUnit } from './install.ts';
import { ensureNativeBackend } from './nativeBackendInstall.ts';
import type { PackagedInstall } from './packagedFile.ts';
import { ensureRoutedPrograms } from './routedInstall.ts';
import { ROUTED_PROGRAMS } from './routedPrograms.ts';

/** Each routed verb goes to its own program beside the bundle; everything else to the bundle. */
export function shimContents(): string {
  const [exec, entry] = bootArgv();
  if (entry === undefined) return `#!/bin/sh\nexec "${exec}" "$@"\n`;
  const routes = ROUTED_PROGRAMS.map(({ verb, file, args }) => {
    const match = [
      `[ "$1" = "${verb}" ]`,
      ...(args
        ? [
            `[ "$#" = "${args.length + 1}" ]`,
            ...args.map((arg, index) => `[ "$${index + 2}" = "${arg}" ]`),
          ]
        : []),
    ].join(' && ');
    return `if ${match}; then\n  exec "${exec}" "${join(dirname(entry), file)}" "$@"\nfi\n`;
  }).join('');
  return `#!/bin/sh\n${routes}exec "${exec}" "${entry}" "$@"\n`;
}

/**
 * Only the default installation may change what the machine shares with it: the PATH command and
 * the boot unit. Both are written to point at THIS process's program, so a daemon started from an
 * isolated data root or from source would aim them at a bundle the next boot cannot rely on. The
 * boot unit's name alone does not protect it — a test machine carried the production label, and a
 * full test run as root on a systemd host rewrote the live unit at a temporary bundle that was gone
 * by the next restart.
 */
export function ownsInstallation(dataDir: string = DATA_DIR, isDev: boolean = IS_DEV): boolean {
  return !isDev && dataDir === DEFAULT_DATA_DIR;
}

export async function ensureShim(path = SHIM_PATH, want = shimContents()): Promise<boolean> {
  const file = Bun.file(path);
  if ((await file.exists()) && (await file.text()) === want) return false;
  mkdirSync(dirname(path), { recursive: true });
  await atomicWrite(path, want, 0o755);
  log.info({ msg: 'installed PATH shim written', path });
  return true;
}

/**
 * Rename window: the previous release's command runs this installation. The machine's move from
 * the previous name deletes the code that command pointed at, and every session started before the
 * update — and every machine still on the previous release — keeps calling it. Only a command that
 * is already there is replaced, and only once the program it will run exists. REMOVE with the window.
 */
export async function bridgePreviousCommand(
  previous = PREVIOUS_COMMAND,
  want = shimContents(),
  program: string | undefined = bootArgv()[1] ?? bootArgv()[0],
): Promise<boolean> {
  if (!existsSync(previous) || program === undefined || !existsSync(program)) return false;
  return ensureShim(previous, want);
}

async function installNativeBackend(): Promise<PackagedInstall | 'not-needed'> {
  const result = await ensureNativeBackend();
  if (result === 'written') log.info({ msg: 'native backend written', dir: NATIVE_BACKEND_DIR });
  return result;
}

async function installRoutedPrograms(): Promise<PackagedInstall> {
  const written = await ensureRoutedPrograms();
  for (const path of written) log.info({ msg: 'routed program written', path });
  return written.length > 0 ? 'written' : 'current';
}

/** The programs the bundle carries, laid down beside it: 'written' when any of them changed. */
export async function ensureEmbeddedArtifacts(): Promise<PackagedInstall> {
  const backend = await installNativeBackend();
  const routed = await installRoutedPrograms();
  return backend === 'written' || routed === 'written' ? 'written' : 'current';
}

/** Install required artifacts before exposing their command routes. Failure aborts startup. */
export async function ensureInstalledApp(m: MachineConfig): Promise<void> {
  // Before anything takes a lock: without the backend a lock cannot record who holds it.
  await installNativeBackend();
  if (!ownsInstallation()) return;
  await installRoutedPrograms();
  await ensureShim();
  await bridgePreviousCommand();
  await convergeBootUnit(m);
}
