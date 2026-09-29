import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bootArgv, DATA_DIR, DEFAULT_DATA_DIR, NATIVE_BACKEND_DIR } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { IS_DEV, SHIM_PATH } from '../util/env.ts';
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
  const routes = ROUTED_PROGRAMS.map(
    ({ verb, file }) =>
      `if [ "$1" = "${verb}" ]; then\n  exec "${exec}" "${join(dirname(entry), file)}" "$@"\nfi\n`,
  ).join('');
  return `#!/bin/sh\n${routes}exec "${exec}" "${entry}" "$@"\n`;
}

/** Only the default installation may change the operator's shared PATH command. */
export function ownsInstalledShim(dataDir: string = DATA_DIR, isDev: boolean = IS_DEV): boolean {
  return !isDev && dataDir === DEFAULT_DATA_DIR;
}

export async function ensureShim(): Promise<boolean> {
  const want = shimContents();
  const file = Bun.file(SHIM_PATH);
  if ((await file.exists()) && (await file.text()) === want) return false;
  mkdirSync(dirname(SHIM_PATH), { recursive: true });
  await atomicWrite(SHIM_PATH, want, 0o755);
  log.info({ msg: 'installed PATH shim written', path: SHIM_PATH });
  return true;
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
  if (ownsInstalledShim()) {
    await installRoutedPrograms();
    await ensureShim();
  }
  await convergeBootUnit(m);
}
