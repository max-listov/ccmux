import { AppError } from "stitchkit";
import { createBoundedChannel, type BoundedChannel } from "stitchkit/application";
import { hasNativeRuntime, runtimeCapabilities } from "../runtime/capabilities.ts";
import { readManagedRuntimeStatus } from "../runtime/status.ts";
import { managedPeer } from "../chat/identity.ts";
import { chatEnabledFor } from "../config/chat.ts";
import { loadSessions } from "../config/sessions.ts";
import type { MonitoringSnapshot } from "../monitoring/schema.ts";
import type { MachineConfig } from "../types.ts";
import { VERSION } from "../util/version.ts";
import { CONTROL_MAX_BYTES, CONTROL_MAX_READERS, ControlSnapshotSchema, currentControlSnapshot,
  type ControlRow, type ControlSnapshot } from "./schema.ts";

/** One producer; readers retain revision notices, never an unbounded queue of snapshots. */
export class ControlPublisher {
  private snapshot: ControlSnapshot;
  private readers = new Set<BoundedChannel<number>>();
  private closed = false;
  private freshness = "";

  constructor(m: MachineConfig) {
    const now = new Date().toISOString();
    this.snapshot = { protocol: 1, version: VERSION, machine: m.rcPrefix, generation: crypto.randomUUID(),
      sequence: 0, status: "unavailable", reason: "observation-pending", observedAt: now, expiresAt: now, omitted: 0, sessions: [] };
  }

  publish(m: MachineConfig, source: MonitoringSnapshot): void {
    if (this.closed) return;
    const sessions = new Map(loadSessions(m).map((s) => [s.name, s]));
    const rows: ControlRow[] = [];
    let omitted = source.omitted;
    let bytes = 4096;
    for (const item of source.sessions) {
      const session = sessions.get(item.name);
      if (!session || session.uuid !== item.uuid || session.agent !== item.agent) { omitted++; continue; }
      const owned = hasNativeRuntime(session);
      const native = owned ? readManagedRuntimeStatus(m, session) : null;
      const expiry = new Date(Date.parse(item.observedAt) + source.maxAgeMs).toISOString();
      const row: ControlRow = {
        identity: managedPeer(m.rcPrefix, session), runtime: session.runtime === "native" ? "native" : owned ? "app-server" : "cli",
        state: native === null ? item.state : native.status === "live" && native.snapshot ? native.snapshot.state : "unknown",
        availability: native?.status ?? "live", reason: native?.reason ?? null,
        observedAt: native?.snapshot?.observedAt ?? item.observedAt,
        expiresAt: native?.snapshot?.expiresAt ?? expiry,
        turn: native?.snapshot?.turn ?? null, model: native?.snapshot?.modelSelection?.model ?? item.model,
        driverCapabilities: runtimeCapabilities(session),
        ...(session.nativeSession === undefined ? {} : { nativeSession: native?.snapshot?.nativeSession ?? session.nativeSession }),
        ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }),
        ...(session.modelSelection === undefined ? {} : { modelSelection: session.modelSelection }),
        capabilities: { message: chatEnabledFor(session, m), start: !session.archived, interrupt: owned, wait: owned },
      };
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + size > CONTROL_MAX_BYTES) { omitted++; continue; }
      bytes += size;
      rows.push(row);
    }
    this.snapshot = ControlSnapshotSchema.parse({ ...this.snapshot, sequence: this.snapshot.sequence + 1,
      status: "live", reason: null, observedAt: source.observedAt,
      expiresAt: new Date(Date.parse(source.observedAt) + source.maxAgeMs).toISOString(), omitted, sessions: rows });
    this.notify();
  }

  read(now = Date.now()): ControlSnapshot { return currentControlSnapshot(this.snapshot, now); }

  expire(now = Date.now()): void {
    if (this.closed) return;
    const state = this.read(now);
    const freshness = JSON.stringify([state.status, state.sessions.map((s) => s.availability)]);
    if (freshness === this.freshness) return;
    this.freshness = freshness;
    this.snapshot.sequence++;
    this.notify();
  }

  unavailable(reason: string): void {
    this.snapshot = { ...this.snapshot, sequence: this.snapshot.sequence + 1, status: "unavailable", reason };
    this.notify();
  }

  subscribe(signal: AbortSignal): AsyncIterable<ControlSnapshot> {
    signal.throwIfAborted();
    if (this.closed) throw new AppError("UNAVAILABLE", "Control publisher is stopped", 503);
    if (this.readers.size >= CONTROL_MAX_READERS) throw new AppError("BUSY", "Resident subscriber limit reached", 429);
    const channel = createBoundedChannel<number>({ policy: "latest", maxItems: 1, maxBytes: 8, sizeOf: () => 8, signal });
    this.readers.add(channel);
    channel.offer(this.snapshot.sequence);
    const remove = () => { this.readers.delete(channel); channel.close({ mode: "discard" }); };
    signal.addEventListener("abort", remove, { once: true });
    const publisher = this;
    return (async function* () {
      try { for await (const _revision of channel) yield publisher.read(); }
      finally { signal.removeEventListener("abort", remove); remove(); }
    })();
  }

  get subscribers(): number { return this.readers.size; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unavailable("daemon-stopped");
    for (const channel of this.readers) channel.close();
  }

  private notify(): void {
    for (const channel of this.readers) channel.offer(this.snapshot.sequence);
  }
}
