import { managedPeer } from '../chat/identity.ts';
import { chatEnabledFor } from '../config/chat.ts';
import type { MonitoringSnapshot } from '../monitoring/schema.ts';
import { sessionApplicationPolicy } from '../policy/projection.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { hasNativeRuntime, runtimeModes } from '../runtime/modes.ts';
import { readSelection } from '../runtime/selection.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { loadSessions } from '../session/registry.ts';
import type { MachineConfig } from '../types.ts';
import { SnapshotPublisher } from '../util/snapshotPublisher.ts';
import { VERSION } from '../util/version.ts';
import {
  CONTROL_MAX_BYTES,
  CONTROL_MAX_READERS,
  type ControlRow,
  type ControlSnapshot,
  ControlSnapshotSchema,
} from './schema/core.ts';
import { currentControlSnapshot } from './schema/runtimeOps.ts';

/** One producer; readers retain revision notices, never an unbounded queue of snapshots. */
export class ControlPublisher extends SnapshotPublisher<ControlSnapshot> {
  private freshness = '';

  constructor(m: MachineConfig) {
    const now = new Date().toISOString();
    super(
      {
        protocol: 1,
        version: VERSION,
        machine: m.rcPrefix,
        generation: crypto.randomUUID(),
        sequence: 0,
        status: 'unavailable',
        reason: 'observation-pending',
        observedAt: now,
        expiresAt: now,
        omitted: 0,
        sessions: [],
      },
      { label: 'Control', limit: CONTROL_MAX_READERS },
    );
  }

  publish(m: MachineConfig, source: MonitoringSnapshot): void {
    if (this.readers.closed) return;
    const sessions = new Map(loadSessions(m).map((s) => [s.name, s]));
    const rows: ControlRow[] = [];
    let omitted = source.omitted;
    let bytes = 4096;
    for (const item of source.sessions) {
      const session = sessions.get(item.name);
      if (!session || session.uuid !== item.uuid || session.agent !== item.agent) {
        omitted++;
        continue;
      }
      const owned = hasNativeRuntime(session);
      const native = owned ? readManagedRuntimeStatus(m, session) : null;
      const expiry = new Date(Date.parse(item.observedAt) + source.maxAgeMs).toISOString();
      const row: ControlRow = {
        identity: managedPeer(m.rcPrefix, session),
        // The mode the session runs in, from the one table that knows them; `cli` is what the
        // control row calls an interactive mode.
        runtime: owned ? runtimeModes[session.agent].native : 'cli',
        state:
          native === null
            ? item.state
            : native.status === 'live' && native.snapshot
              ? native.snapshot.state
              : 'unknown',
        availability: native?.status ?? 'live',
        reason: native?.reason ?? null,
        observedAt: native?.snapshot?.observedAt ?? item.observedAt,
        expiresAt: native?.snapshot?.expiresAt ?? expiry,
        turn: native?.snapshot?.turn ?? null,
        model: native?.snapshot?.nativeSelection?.model.model ?? item.model,
        driverCapabilities: runtimeCapabilities(session),
        ...(session.nativeSession === undefined
          ? {}
          : { nativeSession: native?.snapshot?.nativeSession ?? session.nativeSession }),
        ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }),
        selection: owned ? readSelection(m, session) : null,
        nativeSelection: native?.snapshot?.nativeSelection ?? null,
        ...(native?.snapshot?.nativeProfile === undefined
          ? {}
          : { nativeProfile: native.snapshot.nativeProfile }),
        ...sessionApplicationPolicy(m, session, session.applicationPolicy, native),
        capabilities: {
          message: chatEnabledFor(session, m),
          start: !session.archived,
          interrupt: owned,
          wait: owned,
        },
      };
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + size > CONTROL_MAX_BYTES) {
        omitted++;
        continue;
      }
      bytes += size;
      rows.push(row);
    }
    this.snapshot = ControlSnapshotSchema.parse({
      ...this.snapshot,
      sequence: this.snapshot.sequence + 1,
      status: 'live',
      reason: null,
      observedAt: source.observedAt,
      expiresAt: new Date(Date.parse(source.observedAt) + source.maxAgeMs).toISOString(),
      omitted,
      sessions: rows,
    });
    this.notify();
  }

  read(now = Date.now()): ControlSnapshot {
    return currentControlSnapshot(this.snapshot, now);
  }

  expire(now = Date.now()): void {
    if (this.readers.closed) return;
    const state = this.read(now);
    const freshness = JSON.stringify([state.status, state.sessions.map((s) => s.availability)]);
    if (freshness === this.freshness) return;
    this.freshness = freshness;
    this.snapshot.sequence++;
    this.notify();
  }

  unavailable(reason: string): void {
    this.snapshot = {
      ...this.snapshot,
      sequence: this.snapshot.sequence + 1,
      status: 'unavailable',
      reason,
    };
    this.notify();
  }
}
