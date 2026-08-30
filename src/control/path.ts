import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig } from '../types.ts';

export function controlSocket(m: Pick<MachineConfig, 'stateDir'>): string {
  return join(m.stateDir, 'control', 'api.sock');
}

export function prepareControlDirectory(m: Pick<MachineConfig, 'stateDir'>): void {
  const path = join(m.stateDir, 'control');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('Control directory must be a private directory owned by the current user');
  }
}
