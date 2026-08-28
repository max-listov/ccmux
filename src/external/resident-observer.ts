import { z } from "zod";
import { connectCodexAppServer } from "../agent/codex/appServer.ts";
import type { CodexAppRpc, CodexRpcEvent, CodexRpcOptions } from "../agent/codex/rpc.ts";
import { loadSessions } from "../config/sessions.ts";
import type { MachineConfig } from "../types.ts";
import { log } from "../util/log.ts";
import { NativeStatusEnvelopeSchema, nativeStatusInventory, supportsNativeStatus } from "./native-list.ts";
import { nativeTurnState, TURN_OBSERVATION_DEADLINE_MS } from "./turnState.ts";
import { ExternalStatusPublisher } from "./resident-publisher.ts";
import { EXTERNAL_MAX_ROWS, type ExternalStatusRow, type ExternalStatusSnapshot } from "./resident-schema.ts";

const EventSchema = z.object({ threadId: z.uuid(), status: NativeStatusEnvelopeSchema });
type Connection = { abort: AbortController; root: string | undefined; rpc?: CodexAppRpc };
type Observation = { revision: number; at: number; status: unknown };
type Connector = (machine: MachineConfig, options: CodexRpcOptions) => Promise<CodexAppRpc>;

/** One read-only provider connection with bounded reconciliation and notification overlays. */
export class ExternalStatusObserver {
  private connection: Connection | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private revision = 0;
  private events = new Map<string, Observation>();
  private managed = new Set<string>();
  private stats = { connections: 0, reconciliations: 0, notifications: 0 };

  constructor(private initial: MachineConfig, readonly publisher: ExternalStatusPublisher,
    private connect: Connector = connectCodexAppServer) {}

  refresh(machine: MachineConfig = this.initial, signal?: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.reconcile(machine, signal).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async reconcile(machine: MachineConfig, signal?: AbortSignal): Promise<void> {
    if (machine.stateDir !== this.initial.stateDir || machine.rcPrefix !== this.initial.rcPrefix) {
      this.disconnect("config-changed"); return;
    }
    if (this.connection && this.connection.root !== machine.codexHome) this.disconnect("config-changed");
    this.managed = new Set(loadSessions(machine).filter((s) => s.agent === "codex").map((s) => s.uuid));
    const connection = this.connection ?? { abort: new AbortController(), root: machine.codexHome };
    this.connection = connection;
    const cancel = () => this.disconnect("daemon-stopped", connection);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(() => this.disconnect("deadline", connection), TURN_OBSERVATION_DEADLINE_MS);
    try {
      if (!connection.rpc) {
        this.publisher.reconnect(); this.events.clear(); this.stats.connections++;
        connection.rpc = await this.connect(machine, { signal: connection.abort.signal, maxMessageBytes: 2 * 1024 * 1024,
          onEvent: (event) => this.event(connection, event),
          onClose: (error) => {
            if (this.connection === connection) log.debug({ msg: "external provider connection closed", err: String(error) });
            this.disconnect("connection-unavailable", connection);
          } });
        if (this.connection !== connection || this.stopped) { connection.rpc.close(); return; }
      }
      connection.abort.signal.throwIfAborted();
      if (!supportsNativeStatus(connection.rpc.userAgent)) { this.disconnect("unsupported-runtime", connection); return; }
      const revision = this.revision, startedAt = Date.now();
      this.stats.reconciliations++;
      const inventory = await nativeStatusInventory(connection.rpc, connection.abort.signal);
      if (this.connection !== connection || this.stopped) return;
      const rows = new Map<string, ExternalStatusRow>();
      for (const row of inventory.rows) {
        if (this.managed.has(row.id)) continue;
        const event = this.events.get(row.id);
        const latest = event !== undefined && event.revision > revision ? event : undefined;
        rows.set(row.id, { identity: { provider: "codex", machine: machine.rcPrefix, threadId: row.id },
          name: row.name ?? null, dir: row.cwd ?? null,
          updatedAt: row.updatedAt === undefined ? null : new Date(row.updatedAt * 1000).toISOString(),
          turnState: nativeTurnState(latest?.status ?? row.status, latest?.at ?? startedAt) });
      }
      for (const [id, event] of this.events) {
        if (event.revision > revision && !rows.has(id) && !this.managed.has(id)) rows.set(id, this.eventRow(id, event));
      }
      this.publisher.publish([...rows.values()], inventory.truncated, startedAt);
      for (const [id, event] of this.events) if (event.revision <= revision) this.events.delete(id);
    } catch (error) {
      if (this.connection === connection) {
        log.debug({ msg: "external native observation failed", err: String(error) });
        this.disconnect(error instanceof z.ZodError ? "invalid-response" : "connection-unavailable", connection);
      }
    } finally {
      clearTimeout(deadline); signal?.removeEventListener("abort", cancel);
    }
  }

  private event(connection: Connection, event: CodexRpcEvent): void {
    if (this.connection !== connection || this.stopped || event.method !== "thread/status/changed") return;
    const parsed = EventSchema.safeParse(event.params);
    if (!parsed.success) { this.disconnect("invalid-response", connection); return; }
    const { threadId, status } = parsed.data;
    if (this.managed.has(threadId)) return;
    const observation = { revision: ++this.revision, at: Date.now(), status };
    if (!this.events.has(threadId) && this.events.size >= EXTERNAL_MAX_ROWS) {
      this.disconnect("invalid-response", connection); return;
    }
    this.events.set(threadId, observation); this.stats.notifications++;
    const snapshot = this.publisher.read();
    // Only a complete native reconciliation establishes connection liveness.
    if (snapshot.status !== "live" || snapshot.observedAt === null) return;
    const rows = new Map(snapshot.sessions.map((row) => [row.identity.threadId, row]));
    const previous = rows.get(threadId);
    rows.set(threadId, previous ? { ...previous, turnState: nativeTurnState(status, observation.at) } : this.eventRow(threadId, observation));
    this.publisher.publish([...rows.values()], snapshot.truncated, Date.parse(snapshot.observedAt));
  }

  private eventRow(id: string, event: Observation): ExternalStatusRow {
    return { identity: { provider: "codex", machine: this.initial.rcPrefix, threadId: id },
      name: null, dir: null, updatedAt: null, turnState: nativeTurnState(event.status, event.at) };
  }

  private disconnect(reason: NonNullable<ExternalStatusSnapshot["reason"]>, expected = this.connection): void {
    if (expected !== this.connection) return;
    this.connection = undefined; this.events.clear();
    expected?.abort.abort(); expected?.rpc?.close();
    this.publisher.unavailable(reason);
  }

  metrics() { return { ...this.stats, connected: this.connection?.rpc !== undefined }; }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.disconnect("daemon-stopped");
    await this.running; this.publisher.close();
  }
}
