import { rmSync } from "node:fs";
import { monitoringStatusPath } from "../config/paths.ts";
import { atomicWrite } from "../util/atomic.ts";
import { VERSION } from "../util/version.ts";
import type { MachineConfig, Session } from "../types.ts";
import type { Observed } from "../events/observe.ts";
import { projectMonitoringRow } from "./project.ts";
import { readMonitoringStatus } from "./read.ts";
import { MonitoringRowSchema, MonitoringSnapshotSchema, STATUS_MAX_AGE_MS, STATUS_MAX_BYTES, STATUS_MAX_ITEMS, type MonitoringRow, type MonitoringSnapshot } from "./schema.ts";

/** One producer, one pass in flight, bounded rows; atomic replacement also drops removed sessions. */
export class MonitoringPublisher {
  readonly generation = crypto.randomUUID();
  private sequence = 0;
  private rows: MonitoringRow[] = [];
  private bytes = 0;
  private omitted = 0;
  private started = 0;
  private machine: MachineConfig | null = null;

  begin(m: MachineConfig): void {
    this.machine = m;
    this.rows = [];
    this.bytes = 0;
    this.omitted = 0;
    this.started = Date.now();
  }

  sample = (m: MachineConfig, s: Session, startedAt: number | undefined, pane: string | null, seen: Observed): void => {
    if (this.rows.length >= STATUS_MAX_ITEMS) { this.omitted++; return; }
    const parsed = MonitoringRowSchema.safeParse(projectMonitoringRow(m, s, startedAt, pane, seen));
    if (!parsed.success) { this.omitted++; return; }
    const size = Buffer.byteLength(JSON.stringify(parsed.data)) + 1;
    // Reserve header space, including worst-case numeric/string fields.
    if (this.bytes + size > STATUS_MAX_BYTES - 4096) { this.omitted++; return; }
    this.rows.push(parsed.data);
    this.bytes += size;
  };

  async publish(m: MachineConfig): Promise<MonitoringSnapshot> {
    const now = Date.now();
    const snapshot = MonitoringSnapshotSchema.parse({
      protocol: 1, version: VERSION, generation: this.generation, sequence: ++this.sequence,
      pid: process.pid, rcPrefix: m.rcPrefix, scope: "managed",
      observedAt: new Date(this.started).toISOString(), generatedAt: new Date(now).toISOString(),
      refreshDurationMs: now - this.started, maxAgeMs: STATUS_MAX_AGE_MS,
      limits: { items: STATUS_MAX_ITEMS, bytes: STATUS_MAX_BYTES }, omitted: this.omitted, sessions: this.rows,
    });
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > STATUS_MAX_BYTES) throw new Error("monitoring snapshot exceeds byte limit");
    await atomicWrite(monitoringStatusPath(m), text, 0o600);
    return snapshot;
  }

  stop(): void {
    if (this.machine !== null && readMonitoringStatus(this.machine).snapshot?.generation === this.generation) {
      rmSync(monitoringStatusPath(this.machine), { force: true });
    }
  }
}
