import { nativeContextInfo } from '../agent/claude/native/context.ts';
import type { PaneScan } from '../agent/index.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../types.ts';
import type { NativeSnapshot } from './projectionSchema.ts';
import type { ManagedRuntimeRead } from './schema.ts';
import { readManagedRuntimeStatus } from './status.ts';

export type NativeStep = Pick<TranscriptMessage, 'kind' | 'role' | 'toolName' | 'createdAt'>;

export interface NativeActivity {
  atMs: number | null;
  step: NativeStep | null;
}

/** Combine file-backed and live native conversation timestamps without fabricating either. */
export function latestActivityMs(
  transcriptMs: number | null,
  nativeMs: number | null,
): number | null {
  if (transcriptMs !== null && nativeMs !== null) return Math.max(transcriptMs, nativeMs);
  return transcriptMs ?? nativeMs;
}

/**
 * Latest conversation activity from a live native runtime snapshot.
 *
 * Native runtimes that keep no JSONL transcript on disk report their conversation items in
 * `nativeItems`; picking the newest user/assistant/reasoning/tool item yields both `lastActivityAt`
 * and structural `step`, falling back to `turn.startedAt` when a turn is active before any item
 * has landed.
 */
export function nativeLastActivity(snapshot: NativeSnapshot | null): NativeActivity {
  if (snapshot === null) return { atMs: null, step: null };
  for (let i = snapshot.nativeItems.length - 1; i >= 0; i--) {
    const item = snapshot.nativeItems[i];
    if (
      item === undefined ||
      (item.kind !== 'user' &&
        item.kind !== 'assistant' &&
        item.kind !== 'reasoning' &&
        item.kind !== 'tool')
    )
      continue;
    const parsed = Date.parse(item.at);
    return {
      atMs: Number.isFinite(parsed) ? parsed : null,
      step: {
        kind:
          item.kind === 'tool' ? 'tool_call' : item.kind === 'reasoning' ? 'thinking' : 'message',
        role: item.kind === 'user' ? 'user' : 'assistant',
        toolName: item.kind === 'tool' ? item.tool : null,
        createdAt: item.at,
      },
    };
  }
  const turnAt = snapshot.turn?.startedAt ? Date.parse(snapshot.turn.startedAt) : Number.NaN;
  return { atMs: Number.isFinite(turnAt) ? turnAt : null, step: null };
}

export function managedRuntimeView(
  m: MachineConfig,
  s: Session,
  now = Date.now(),
): {
  read: ManagedRuntimeRead;
  state: 'working' | 'idle' | 'blocked';
  atPrompt: string | null;
  turnStartedAt: string | null;
  activity: NativeActivity;
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
    activity:
      read.status === 'live' ? nativeLastActivity(read.snapshot) : { atMs: null, step: null },
    scan: {
      ready: read.status === 'live',
      state: native === 'unknown' ? 'indeterminate' : native === 'working' ? 'working' : 'idle',
      atPrompt,
      contextLabel: context.text ?? '-',
      context,
    },
  };
}
