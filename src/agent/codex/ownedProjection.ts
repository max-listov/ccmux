import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import type { CodexRpcEvent } from "./rpc.ts";
import { nativeTurnState } from "../../external/turnState.ts";
import { CODEX_RUNTIME_MAX_EVENTS, CODEX_RUNTIME_TTL_MS, type OwnedCodexSnapshot, type OwnedCodexTurn } from "./ownedSchema.ts";
import { VERSION } from "../../util/version.ts";

const StatusEvent = z.object({ threadId: z.uuid(), status: z.unknown() });
const TurnEvent = z.object({ threadId: z.uuid(), turn: z.object({
  id: z.string().min(1).max(256), status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
}) });

/** State belongs to one connection generation. Snapshot reconciliation is revision guarded. */
export class OwnedCodexProjection {
  private value: OwnedCodexSnapshot;
  revision = 0;

  constructor(m: MachineConfig, s: Session, providerPid: number, now = Date.now()) {
    this.value = {
      protocol: 1, provider: "codex", machine: m.rcPrefix, session: s.name, threadId: s.uuid,
      generation: crypto.randomUUID(), sequence: 0, pid: process.pid, providerPid, version: VERSION,
      connected: false, state: "unknown", reason: "starting", observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now).toISOString(), turn: null, events: [],
    };
  }

  snapshot(): OwnedCodexSnapshot { return structuredClone(this.value); }

  reconcile(status: unknown, revision: number, now = Date.now()): boolean {
    if (revision !== this.revision) return false;
    this.applyStatus(status, now);
    return true;
  }

  restoreTurn(turn: OwnedCodexTurn | null): void {
    this.value.turn = turn === null ? null : { ...turn,
      startedAt: turn.startedAt ?? (this.value.turn?.id === turn.id ? this.value.turn.startedAt : null) };
  }

  event(event: CodexRpcEvent, now = Date.now()): boolean {
    if (event.method === "thread/status/changed") {
      const parsed = StatusEvent.safeParse(event.params);
      if (!parsed.success || parsed.data.threadId !== this.value.threadId) return false;
      this.revision++;
      this.applyStatus(parsed.data.status, now);
      return true;
    }
    if (event.method !== "turn/started" && event.method !== "turn/completed") return false;
    const parsed = TurnEvent.safeParse(event.params);
    if (!parsed.success || parsed.data.threadId !== this.value.threadId) return false;
    const { turn } = parsed.data;
    if (event.method === "turn/completed" && this.value.turn !== null && this.value.turn.id !== turn.id) return false;
    if (this.value.turn?.id === turn.id && this.value.turn.status === turn.status) return false;
    this.revision++;
    const previous = this.value.turn;
    this.value.turn = { id: turn.id, status: turn.status,
      startedAt: event.method === "turn/started" ? new Date(now).toISOString() : previous?.startedAt ?? null };
    // A matching completion is terminal evidence. Unknown/failed remains separate from idle.
    this.value.connected = true;
    this.value.state = event.method === "turn/started" ? "working" : turn.status === "failed" ? "unknown" : "idle";
    this.value.reason = turn.status === "failed" ? "turn-failed" : null;
    this.touch(now);
    this.append(event.method === "turn/started" ? "turn-start" : "turn-end", now);
    return true;
  }

  unavailable(reason: string, now = Date.now()): void {
    this.revision++;
    this.value.connected = false;
    this.value.state = "unknown";
    this.value.reason = reason;
    this.value.expiresAt = new Date(now).toISOString();
    this.append("unavailable", now);
  }

  private applyStatus(status: unknown, now: number): void {
    const native = nativeTurnState(status, now);
    const reason = native.evidence === "observed" ? null : native.reason;
    const changed = this.value.state !== native.state || this.value.reason !== reason || !this.value.connected;
    this.value.connected = true;
    this.value.state = native.state;
    this.value.reason = reason;
    this.touch(now);
    if (changed) this.append("state", now);
  }

  private touch(now: number): void {
    this.value.observedAt = new Date(now).toISOString();
    this.value.expiresAt = new Date(now + CODEX_RUNTIME_TTL_MS).toISOString();
  }

  private append(kind: OwnedCodexSnapshot["events"][number]["kind"], now: number): void {
    const event = { sequence: ++this.value.sequence, kind, at: new Date(now).toISOString(),
      state: this.value.state, turn: this.value.turn === null ? null : { ...this.value.turn } };
    this.value.events = [...this.value.events, event].slice(-CODEX_RUNTIME_MAX_EVENTS);
  }
}
