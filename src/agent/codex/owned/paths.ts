import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { hasNativeRuntime } from '../../../runtime/modes.ts';
import type { MachineConfig, Session } from '../../../types.ts';

export function isOwnedCodex(s: Pick<Session, 'agent' | 'runtime'>): boolean {
  return s.agent === 'codex' && hasNativeRuntime(s);
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
