import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineConfig, Session } from '../../types.ts';

export function isOwnedCodex(s: Pick<Session, 'agent' | 'runtime'>): boolean {
  return s.agent === 'codex' && s.runtime === 'app-server';
}

const key = (m: Pick<MachineConfig, 'stateDir'>, name: string): string =>
  createHash('sha256')
    .update(JSON.stringify([m.stateDir, name]))
    .digest('hex')
    .slice(0, 24);

/** Short Unix paths work on macOS too; instance identity prevents cross-checkout collisions. */
export function ownedCodexSocket(m: Pick<MachineConfig, 'stateDir'>, name: string): string {
  return join('/tmp', `ccmux-codex-${process.getuid?.() ?? 0}`, `${key(m, name)}.sock`);
}

export function ownedCodexStatusPath(m: Pick<MachineConfig, 'stateDir'>, name: string): string {
  return join(m.stateDir, 'codex-runtime', `${key(m, name)}.json`);
}

export function privateRuntimeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      'Codex runtime directory must be a private directory owned by the current user',
    );
  }
}
