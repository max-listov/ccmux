import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bootArgv,
  DATA_DIR,
  DEFAULT_DATA_DIR,
  NATIVE_BACKEND_DIR,
  STATUS_LINE_APP,
} from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { IS_DEV, SHIM_PATH } from '../util/env.ts';
import { log } from '../util/log.ts';
import { convergeBootUnit } from './install.ts';
import { ensureNativeBackend } from './nativeBackendInstall.ts';
import type { PackagedInstall } from './packagedFile.ts';
import { ensureStatusLineApp } from './statusLineInstall.ts';

/** The installed status-line command requires its packaged artifact. */
export function shimContents(): string {
  const [exec, entry] = bootArgv();
  if (entry === undefined) return `#!/bin/sh\nexec "${exec}" "$@"\n`;
  const program = join(dirname(entry), 'status-line.js');
  return (
    `#!/bin/sh\n` +
    `if [ "$1" = "status-line" ]; then\n` +
    `  exec "${exec}" "${program}" "$@"\n` +
    `fi\n` +
    `exec "${exec}" "${entry}" "$@"\n`
  );
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

async function installStatusLine(): Promise<PackagedInstall> {
  const result = await ensureStatusLineApp();
  if (result === 'written') log.info({ msg: 'status-line program written', path: STATUS_LINE_APP });
  return result;
}

/** The programs the bundle carries, laid down beside it: 'written' when any of them changed. */
export async function ensureEmbeddedArtifacts(): Promise<PackagedInstall> {
  const backend = await installNativeBackend();
  const statusLine = await installStatusLine();
  return backend === 'written' || statusLine === 'written' ? 'written' : 'current';
}

/** Install required artifacts before exposing their command routes. Failure aborts startup. */
export async function ensureInstalledApp(m: MachineConfig): Promise<void> {
  // Before anything takes a lock: without the backend a lock cannot record who holds it.
  await installNativeBackend();
  if (ownsInstalledShim()) {
    await installStatusLine();
    await ensureShim();
  }
  await convergeBootUnit(m);
}
