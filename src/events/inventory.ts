import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { lastTranscriptMessage } from '../agent/index.ts';
import { inventoryPath } from '../config/paths.ts';
import {
  type InventoryRow,
  type InventorySnapshot,
  InventorySnapshotSchema,
} from '../config/schema.ts';
import type { MonitoringRow } from '../monitoring/schema.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { appendRecord, buildEvent } from './feed.ts';

/**
 * The machine's session inventory, as the observation pass sees it, published as CHANGES.
 *
 * A consumer that follows the feed otherwise learns that something happened and then has to ask
 * `list`/`fleet` what the machine now looks like — a process per question, and a question per burst
 * of events. The daemon already builds every session's row once per pass for the monitoring
 * snapshot; this compares it with the previous pass and appends one `inventory` event per session
 * that appeared, changed or left, carrying the row itself.
 *
 * A row holds only what changes at the pace of the session's own life — state, model, context, the
 * step it is on — and never a clock that moves by itself: uptime is its start INSTANT, and the
 * per-pass observation times are left out. Otherwise every pass would be a change and the feed would
 * be a poll written to disk. The step is structural (kind, role, tool, when); message text stays in
 * the transcript, behind its own command, as it does for every other event.
 *
 * Every change advances the inventory `sequence` inside this daemon's `generation`. The snapshot
 * (`inventory.json`, relayed by `list --json` and `fleet --json`) carries the same pair, so a
 * consumer applies an event only when it is exactly the next one, drops the ones it already holds,
 * and takes a snapshot again on anything else. A new daemon is a new generation: its first pass has
 * nothing to compare with and announces every row once, which is state re-observed, not history
 * replayed — and which tells any consumer still holding the old generation to re-read.
 */
export function inventoryRow(
  row: MonitoringRow,
  startedAt: number | undefined,
  message: TranscriptMessage | null,
): InventoryRow {
  return {
    name: row.name,
    agent: row.agent,
    uuid: row.uuid,
    address: row.address,
    archived: row.archived,
    running: row.running,
    state: row.state,
    model: row.model,
    // Whole percent: the fraction moves with every token and says nothing a reader acts on.
    contextPercent: row.contextPercent === null ? null : Math.round(row.contextPercent),
    startedAt: startedAt === undefined ? null : new Date(startedAt * 1000).toISOString(),
    turnStartedAt: row.turnStartedAt,
    step:
      row.running && message !== null
        ? {
            kind: message.kind,
            role: message.role,
            toolName: message.toolName,
            at: message.createdAt,
          }
        : null,
  };
}

export interface InventoryChange {
  name: string;
  before: InventoryRow | null;
  after: InventoryRow | null;
}

/** What differs between two passes, ordered by name so a replay of the same passes is the same. */
export function inventoryChanges(
  previous: ReadonlyMap<string, InventoryRow>,
  next: readonly InventoryRow[],
): InventoryChange[] {
  const changes: InventoryChange[] = [];
  const seen = new Set<string>();
  for (const row of next) {
    seen.add(row.name);
    const before = previous.get(row.name) ?? null;
    if (before === null || JSON.stringify(before) !== JSON.stringify(row))
      changes.push({ name: row.name, before, after: row });
  }
  for (const [name, before] of previous)
    if (!seen.has(name)) changes.push({ name, before, after: null });
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

/** One pass in, events and a snapshot out. Owned by the daemon; nothing else writes either. */
export class InventoryPublisher {
  readonly generation = randomUUID();
  private sequence = 0;
  private current = new Map<string, InventoryRow>();
  private pass: InventoryRow[] = [];
  private written = false;
  private machine: MachineConfig | null = null;

  begin(m: MachineConfig): void {
    this.machine = m;
    this.pass = [];
  }

  sample(m: MachineConfig, s: Session, row: MonitoringRow, startedAt: number | undefined): void {
    this.pass.push(inventoryRow(row, startedAt, row.running ? lastTranscriptMessage(s, m) : null));
  }

  /**
   * The sequence advances whether or not the feed is switched on. With it off, a consumer holding a
   * snapshot sees the gap on its next read and re-reads, instead of trusting rows that have quietly
   * stopped being maintained.
   */
  async publish(m: MachineConfig, publishEvents: boolean, nowIso = new Date().toISOString()) {
    const changes = inventoryChanges(this.current, this.pass);
    for (const change of changes) {
      this.sequence += 1;
      const row = change.after ?? change.before;
      if (!publishEvents || row === null) continue;
      appendRecord(
        m,
        buildEvent(
          m,
          row,
          {
            event: 'inventory',
            inventory: { generation: this.generation, sequence: this.sequence },
            row: change.after,
          },
          randomUUID(),
          nowIso,
        ),
      );
    }
    this.current = new Map(this.pass.map((row) => [row.name, row]));
    if (changes.length === 0 && this.written) return this.snapshot();
    const snapshot = this.snapshot();
    await atomicWrite(inventoryPath(m), JSON.stringify(snapshot), 0o600);
    this.written = true;
    return snapshot;
  }

  snapshot(): InventorySnapshot {
    return {
      generation: this.generation,
      sequence: this.sequence,
      pid: process.pid,
      sessions: [...this.current.values()],
    };
  }

  stop(): void {
    if (this.machine !== null && readInventory(this.machine)?.generation === this.generation)
      rmSync(inventoryPath(this.machine), { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The published inventory, or null when there is none to continue from: no daemon has written one,
 * the file is unreadable, or the daemon that wrote it is gone. A dead producer's rows are not an
 * inventory — nothing will ever send the change that makes them wrong.
 */
export function readInventory(m: MachineConfig): InventorySnapshot | null {
  try {
    const parsed = InventorySnapshotSchema.safeParse(
      JSON.parse(readFileSync(inventoryPath(m), 'utf8')),
    );
    return parsed.success && alive(parsed.data.pid) ? parsed.data : null;
  } catch {
    return null;
  }
}
