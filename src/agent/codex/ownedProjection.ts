import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import type { CodexRpcEvent, CodexRpcRequest } from "./rpc.ts";
import { nativeTurnState } from "../../external/turnState.ts";
import { CODEX_RUNTIME_MAX_EVENTS, CODEX_RUNTIME_MAX_NATIVE_ITEMS, CODEX_RUNTIME_TTL_MS,
  type OwnedCodexNativeItem, type OwnedCodexPendingRequest, type OwnedCodexSnapshot, type OwnedCodexTurn } from "./ownedSchema.ts";
import { VERSION } from "../../util/version.ts";
import { projectNativeEvent, projectNativeRequest, resolvedRequestId } from "./ownedNative.ts";

const StatusEvent = z.object({ threadId: z.uuid(), status: z.unknown() });
const TurnEvent = z.object({ threadId: z.uuid(), turn: z.object({
  id: z.string().min(1).max(256), status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
}) });

/** State belongs to one connection generation. Snapshot reconciliation is revision guarded. */
export class OwnedCodexProjection {
  private value: OwnedCodexSnapshot;
  private submittedRequests = new Map<string, OwnedCodexPendingRequest>();
  revision = 0;

  constructor(m: MachineConfig, s: Session, providerPid: number, now = Date.now()) {
    this.value = {
      protocol: 1, provider: "codex", machine: m.rcPrefix, session: s.name, threadId: s.uuid,
      generation: crypto.randomUUID(), sequence: 0, pid: process.pid, providerPid, version: VERSION,
      connected: false, state: "unknown", reason: "starting", observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now).toISOString(), turn: null, events: [], nativeSequence: 0,
      nativeItems: [], pendingRequests: [],
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
    let changed = false;
    if (event.method === "turn/started" || event.method === "turn/completed") {
      const parsed = TurnEvent.safeParse(event.params);
      if (!parsed.success || parsed.data.threadId !== this.value.threadId) return false;
      const { turn } = parsed.data;
      if (event.method === "turn/completed" && this.value.turn !== null && this.value.turn.id !== turn.id) return false;
      if (this.value.turn?.id === turn.id && this.value.turn.status === turn.status) return false;
      {
        this.revision++;
        const previous = this.value.turn;
        this.value.turn = { id: turn.id, status: turn.status,
          startedAt: event.method === "turn/started" ? new Date(now).toISOString() : previous?.startedAt ?? null };
        this.value.connected = true;
        this.value.state = event.method === "turn/started" ? "working" : turn.status === "failed" ? "unknown" : "idle";
        this.value.reason = turn.status === "failed" ? "turn-failed" : null;
        this.touch(now);
        this.append(event.method === "turn/started" ? "turn-start" : "turn-end", now);
        changed = true;
      }
    }
    const resolved = resolvedRequestId(event, this.value.threadId);
    if (resolved !== null) changed = this.resolveRequest(resolved, now) || changed;
    const native = projectNativeEvent(event, this.value.threadId, this.value.nativeSequence + 1, now);
    if (native !== null) { this.appendNative(native); changed = true; }
    return changed;
  }

  request(request: CodexRpcRequest, now = Date.now()): boolean {
    const pending = projectNativeRequest(request, this.value.threadId, now);
    if (pending === null || this.value.pendingRequests.some((item) => item.requestId === pending.requestId)
      || this.submittedRequests.has(pending.requestId)) return false;
    this.value.pendingRequests = [...this.value.pendingRequests, pending].slice(-4);
    this.value.state = pending.kind === "approval" ? "waiting-approval" : "waiting-input";
    this.touch(now);
    this.appendNative({ sequence: this.value.nativeSequence + 1, at: pending.requestedAt,
      kind: pending.kind, stage: "requested", nativeId: pending.itemId, turnId: pending.turnId,
      requestId: pending.requestId, status: null, text: pending.reason, tool: pending.approvalKind, usage: null });
    return true;
  }

  pendingRequest(requestId: string): OwnedCodexPendingRequest | null {
    return this.value.pendingRequests.find((item) => item.requestId === requestId) ?? null;
  }

  submitRequest(requestId: string, now = Date.now()): boolean {
    const pending = this.pendingRequest(requestId);
    if (pending === null) return false;
    this.value.pendingRequests = this.value.pendingRequests.filter((item) => item.requestId !== requestId);
    this.submittedRequests.set(requestId, pending);
    if (this.value.pendingRequests.length === 0 && this.value.turn?.status === "inProgress") this.value.state = "working";
    this.touch(now);
    this.appendNative({ sequence: this.value.nativeSequence + 1, at: new Date(now).toISOString(), kind: pending.kind,
      stage: "submitted", nativeId: pending.itemId, turnId: pending.turnId, requestId, status: null,
      text: null, tool: pending.approvalKind, usage: null });
    return true;
  }

  resolveRequest(requestId: string, now = Date.now()): boolean {
    const pending = this.pendingRequest(requestId) ?? this.submittedRequests.get(requestId) ?? null;
    if (pending === null) return false;
    this.value.pendingRequests = this.value.pendingRequests.filter((item) => item.requestId !== requestId);
    this.submittedRequests.delete(requestId);
    if (this.value.pendingRequests.length === 0 && this.value.turn?.status === "inProgress") this.value.state = "working";
    this.touch(now);
    this.appendNative({ sequence: this.value.nativeSequence + 1, at: new Date(now).toISOString(), kind: pending.kind,
      stage: "resolved", nativeId: pending.itemId, turnId: pending.turnId, requestId, status: null,
      text: null, tool: pending.approvalKind, usage: null });
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

  private appendNative(item: OwnedCodexNativeItem): void {
    this.value.nativeSequence = item.sequence;
    const items = [...this.value.nativeItems, item].slice(-CODEX_RUNTIME_MAX_NATIVE_ITEMS);
    while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > 64 * 1024) items.shift();
    this.value.nativeItems = items;
  }
}
