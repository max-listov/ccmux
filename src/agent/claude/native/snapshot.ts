import {
  NATIVE_RUNTIME_MAX_NATIVE_ITEMS,
  NATIVE_RUNTIME_TTL_MS,
  type NativeSnapshot,
  NativeSnapshotSchema,
} from '../../../runtime/projectionSchema.ts';
import type { TurnState } from './turn.ts';

/**
 * The observation this runtime publishes about itself.
 *
 * Composed as a pure function of identity, turn state and what has been collected, because a
 * snapshot is the only thing every reader — `list`, `wait`, chat delivery, the control plane, the
 * fleet map — believes about a session it cannot see. A composer that quietly filled in a plausible
 * value would put that value in front of all of them at once.
 */

export interface SnapshotIdentity {
  machine: string;
  session: string;
  threadId: string;
  generation: string;
  pid: number;
  providerPid: number;
  version: string;
}

export interface SnapshotInput {
  identity: SnapshotIdentity;
  sequence: number;
  connected: boolean;
  turn: TurnState;
  turnId: string | null;
  turnStartedAt: string | null;
  items: readonly NativeSnapshot['nativeItems'][number][];
  pending: readonly NativeSnapshot['pendingRequests'][number][];
  selection: NativeSnapshot['nativeSelection'];
  permissionMode: NativeSnapshot['permissionMode'];
  contextUsage: NativeSnapshot['contextUsage'];
  account: NativeSnapshot['account'];
  spend: NativeSnapshot['spend'];
  fileCheckpoints: NativeSnapshot['fileCheckpoints'];
  mcpServers: NativeSnapshot['mcpServers'];
  now: number;
}

/**
 * The reason a reader is given for the current state, or null when the state speaks for itself.
 *
 * A disconnected runtime is the one case where saying nothing would be actively misleading: the
 * last observation stays on disk, and without a reason it reads as a live session that simply
 * stopped moving.
 */
function reasonFor(input: SnapshotInput): string | null {
  if (!input.connected) return 'runtime-disconnected';
  if (input.turn.unhandled.length === 0) return null;
  // Unrecognised members are surfaced rather than dropped: a build older than the runtime it drives
  // will otherwise present a partial conversation as a complete one.
  return `unhandled-messages: ${input.turn.unhandled.slice(0, 4).join(',')}`;
}

export function composeSnapshot(input: SnapshotInput): NativeSnapshot {
  const observedAt = new Date(input.now).toISOString();
  return NativeSnapshotSchema.parse({
    protocol: 1,
    provider: 'claude',
    machine: input.identity.machine,
    session: input.identity.session,
    threadId: input.identity.threadId,
    generation: input.identity.generation,
    sequence: input.sequence,
    pid: input.identity.pid,
    providerPid: input.identity.providerPid,
    version: input.identity.version,
    connected: input.connected,
    // A disconnected runtime knows nothing about what the session is doing. Publishing the last
    // state it saw would keep asserting a fact whose source has gone away.
    state: input.connected ? input.turn.state : 'unknown',
    reason: reasonFor(input),
    observedAt,
    // The lease is what stops a stale file being read as a live observation, so it is stamped from
    // the same instant rather than from whenever the write happens to land.
    expiresAt: new Date(input.now + NATIVE_RUNTIME_TTL_MS).toISOString(),
    turn:
      input.turnId === null || input.turn.status === null
        ? null
        : { id: input.turnId, status: input.turn.status, startedAt: input.turnStartedAt },
    events: [],
    nativeSequence: input.items.length,
    // Newest kept, oldest dropped: a bounded window that discarded the RECENT end would answer
    // "what is happening now" with what happened first.
    nativeItems: input.items.slice(-NATIVE_RUNTIME_MAX_NATIVE_ITEMS),
    pendingRequests: input.pending.slice(0, 16),
    nativeSelection: input.selection,
    permissionMode: input.permissionMode,
    contextUsage: input.contextUsage,
    account: input.account,
    spend: input.spend,
    fileCheckpoints: input.fileCheckpoints,
    mcpServers: input.mcpServers,
  });
}
