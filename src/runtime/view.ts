import { nativeContextInfo } from '../agent/claude/native/context.ts';
import type { PaneScan } from '../agent/index.ts';
import type { MachineConfig, Session } from '../types.ts';
import type { ManagedRuntimeRead } from './schema.ts';
import { readManagedRuntimeStatus } from './status.ts';

export function managedRuntimeView(
  m: MachineConfig,
  s: Session,
  now = Date.now(),
): {
  read: ManagedRuntimeRead;
  state: 'working' | 'idle' | 'blocked';
  atPrompt: string | null;
  turnStartedAt: string | null;
  scan: PaneScan;
} {
  const read = readManagedRuntimeStatus(m, s, Math.max(now, Date.now()));
  const native = read.snapshot?.state ?? 'unknown';
  const atPrompt = native === 'waiting-approval' || native === 'waiting-input' ? native : null;
  // The runtime's own measurement, not a pane scrape: a native session has no pane to read, which is
  // why it reported no context at all before this.
  const context = nativeContextInfo(read.snapshot);
  const state =
    native === 'working' ? 'working' : native === 'idle' || atPrompt !== null ? 'idle' : 'blocked';
  return {
    read,
    state,
    atPrompt,
    turnStartedAt: native === 'working' ? (read.snapshot?.turn?.startedAt ?? null) : null,
    scan: {
      ready: read.status === 'live',
      state: native === 'unknown' ? 'indeterminate' : native === 'working' ? 'working' : 'idle',
      atPrompt,
      contextLabel: context.text ?? '-',
      context,
    },
  };
}
