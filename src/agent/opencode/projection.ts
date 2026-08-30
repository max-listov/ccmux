import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import type { ManagedRuntimeSnapshot } from "../../runtime/schema.ts";
import type { OwnedCodexNativeItem, OwnedCodexPendingRequest } from "../codex/ownedSchema.ts";
import { VERSION } from "../../util/version.ts";
import { ApplicationPolicyEvidenceSchema } from "../../policy/reference.ts";
import type { ApplicationPolicyEvidence } from "../../policy/reference.ts";
import { OpenCodeDeltaSchema, OpenCodeEventSchema, OpenCodeMessageSchema, OpenCodePartSchema, OpenCodePermissionSchema,
  OpenCodeQuestionSchema, OpenCodeStatusSchema, openCodeTerminal, type OpenCodeMessage, type OpenCodePart } from "./protocol.ts";

type Item = Omit<OwnedCodexNativeItem, "sequence" | "at">;
const ItemDefaults = { requestId: null, status: null, text: null, tool: null, usage: null };

/** One observer epoch; bounded causal records and exact native request identities. */
export class OpenCodeProjection {
  private value: ManagedRuntimeSnapshot;
  private parents = new Map<string, string>();
  private privateMessages = new Set<string>();
  revision = 0;

  constructor(m: MachineConfig, session: Session, providerPid: number, private report?: (error: unknown) => void) {
    if (session.nativeSession?.runtime !== "opencode") throw new Error("OpenCode continuation is missing");
    const now = new Date().toISOString();
    this.value = { protocol: 1, provider: "opencode", machine: m.rcPrefix, session: session.name, threadId: session.uuid,
      generation: crypto.randomUUID(), registrationGeneration: session.registrationGeneration,
      nativeSession: session.nativeSession, nativeSelection: null,
      sequence: 0, pid: process.pid, providerPid, version: VERSION, connected: false, state: "unknown",
      reason: "starting", observedAt: now, expiresAt: now, turn: null, events: [], nativeSequence: 0, nativeItems: [], pendingRequests: [],
      ...(session.applicationPolicy === undefined ? {} : { applicationPolicy: { policy: session.applicationPolicy, state: "desired" } }) };
  }

  snapshot(): ManagedRuntimeSnapshot { return structuredClone(this.value); }
  policyEvidence(evidence: ApplicationPolicyEvidence): void {
    if (this.value.applicationPolicy?.policy.digest !== evidence.policy.digest) throw new Error("Native policy identity changed");
    this.value.applicationPolicy = ApplicationPolicyEvidenceSchema.parse(evidence);
  }
  private own(id: string): boolean { return id === this.value.nativeSession?.id; }
  private touch(kind: ManagedRuntimeSnapshot["events"][number]["kind"] = "state"): void {
    const now = Date.now();
    this.value.sequence++;
    this.value.observedAt = new Date(now).toISOString();
    this.value.expiresAt = new Date(now + 5_000).toISOString();
    this.value.events.push({ sequence: this.value.sequence, kind, at: this.value.observedAt,
      state: this.value.state, turn: this.value.turn === null ? null : { ...this.value.turn } });
    if (this.value.events.length > 128) this.value.events.shift();
  }
  append(item: Item): void {
    this.value.nativeSequence++;
    this.value.nativeItems.push({ ...item, sequence: this.value.nativeSequence, at: new Date().toISOString() });
    while (this.value.nativeItems.length > 128 || Buffer.byteLength(JSON.stringify(this.value)) > 112 * 1024) {
      if (this.value.nativeItems.length === 0) throw new Error("Native request projection exceeded its byte budget");
      this.value.nativeItems.shift();
    }
    this.touch();
  }
  start(messageId: string, at = Date.now()): void {
    this.parents.clear();
    this.privateMessages.clear();
    this.parents.set(messageId, messageId);
    this.value.turn = { id: messageId, status: "inProgress", startedAt: new Date(at).toISOString() };
    this.value.state = "working";
    this.append({ ...ItemDefaults, kind: "user", stage: "started", nativeId: messageId, turnId: messageId });
    this.touch("turn-start");
  }
  unavailable(reason: string): void {
    if (this.value.applicationPolicy !== undefined) this.value.applicationPolicy.state = "unavailable";
    this.value.connected = false; this.value.state = "unknown"; this.value.reason = reason; this.touch("unavailable");
  }
  status(raw: unknown, revision = this.revision): void {
    const status = OpenCodeStatusSchema.parse(raw);
    if (revision !== this.revision) return;
    this.value.connected = true; this.value.reason = null;
    const pending = this.value.pendingRequests[0];
    this.value.state = pending ? pending.kind === "approval" ? "waiting-approval" : "waiting-input"
      : status.type !== "idle" ? "working" : this.value.turn?.status === "inProgress" ? "unknown" : "idle";
    if (this.value.state === "unknown") this.value.reason = "awaiting-terminal-evidence";
    this.touch();
  }
  message(message: OpenCodeMessage, complete = true): void {
    if (!this.own(message.sessionID)) return;
    if (message.role === "user") {
      if (this.value.turn?.startedAt && message.time.created < Date.parse(this.value.turn.startedAt)) return;
      if (this.value.turn?.id !== message.id) this.start(message.id, message.time.created);
      return;
    }
    if (message.parentID === undefined || this.value.turn?.id !== message.parentID) return;
    if (this.parents.size >= 256 && !this.parents.has(message.id)) this.parents.delete(this.parents.keys().next().value ?? "");
    this.parents.set(message.id, message.parentID);
    if (message.summary === true) {
      this.privateMessages.add(message.id);
      while (this.privateMessages.size > 256) this.privateMessages.delete(this.privateMessages.values().next().value ?? "");
    }
    if (message.providerID && message.modelID) this.value.nativeSelection = {
      model: { provider: message.providerID, model: message.modelID }, options: null, source: "assistant", turnId: message.parentID };
    const outcome = openCodeTerminal(message);
    if (!complete || outcome === null || this.value.turn.status !== "inProgress") return;
    if (outcome === "failed") this.report?.({ messageId: message.id, error: message.error });
    const tokens = message.tokens;
    if (tokens) this.append({ ...ItemDefaults, kind: "usage", stage: "completed", nativeId: message.id,
      turnId: message.parentID, usage: { totalTokens: tokens.total ?? tokens.input + tokens.output + tokens.cache.read + tokens.cache.write,
        inputTokens: tokens.input, outputTokens: tokens.output, reasoningOutputTokens: tokens.reasoning, cachedInputTokens: tokens.cache.read } });
    this.value.turn.status = outcome;
    this.value.state = "idle";
    this.append({ ...ItemDefaults, kind: "terminal", stage: "completed", nativeId: message.id,
      turnId: message.parentID, status: outcome });
    this.touch("turn-end");
  }
  part(part: OpenCodePart): void {
    if (!this.own(part.sessionID)) return;
    const turnId = this.parents.get(part.messageID);
    if (turnId === undefined || turnId !== this.value.turn?.id) return;
    if (part.synthetic === true || this.privateMessages.has(part.messageID)) return;
    if (part.type === "text" || part.type === "reasoning") {
      this.append({ ...ItemDefaults, kind: part.messageID === turnId ? "user" : part.type === "text" ? "assistant" : "reasoning",
        stage: part.time?.end === undefined ? "updated" : "completed", nativeId: part.id, turnId, text: part.text?.slice(-8_192) ?? null });
    } else if (part.type === "tool" && part.state && part.tool) {
      if (part.state.status === "error") this.report?.({ partId: part.id, error: part.state.error });
      this.append({ ...ItemDefaults, kind: "tool", stage: ["completed", "error"].includes(part.state.status) ? "completed" : "started",
        nativeId: part.callID ?? part.id, turnId, status: part.state.status, tool: part.tool.slice(0, 128),
        text: part.state.status === "error" ? "Native tool failed" : null });
    }
  }
  private delta(raw: unknown): void {
    const delta = OpenCodeDeltaSchema.parse(raw);
    if (!this.own(delta.sessionID) || delta.field !== "text" || this.privateMessages.has(delta.messageID)
      || this.parents.get(delta.messageID) !== this.value.turn?.id) return;
    const prior = this.value.nativeItems.findLast(item => item.nativeId === delta.partID && item.turnId === this.value.turn?.id);
    if (prior === undefined || !["assistant", "reasoning", "user"].includes(prior.kind)) return;
    this.append({ ...prior, stage: "updated", text: ((prior.text ?? "") + delta.delta).slice(-8_192) });
  }
  pending(request: OwnedCodexPendingRequest): void {
    if (this.value.pendingRequests.some((value) => value.requestId === request.requestId)) return;
    if (this.value.pendingRequests.length >= 4) throw new Error("Native request window exceeded");
    this.value.pendingRequests.push(request);
    this.value.state = request.kind === "approval" ? "waiting-approval" : "waiting-input";
    this.append({ ...ItemDefaults, kind: request.kind, stage: "requested", nativeId: request.itemId,
      turnId: request.turnId, requestId: request.requestId, text: request.reason });
  }
  resolve(requestId: string): void {
    const request = this.value.pendingRequests.find((value) => value.requestId === requestId);
    if (!request) return;
    this.value.pendingRequests = this.value.pendingRequests.filter((value) => value.requestId !== requestId);
    this.append({ ...ItemDefaults, kind: request.kind, stage: "resolved", nativeId: request.itemId, turnId: request.turnId, requestId });
    this.status({ type: this.value.turn?.status === "inProgress" ? "busy" : "idle" });
  }
  event(raw: unknown): void {
    const event = OpenCodeEventSchema.parse(raw);
    this.revision++;
    if (event.type === "message.updated") this.message(OpenCodeMessageSchema.parse(z.object({ info: z.unknown() }).parse(event.properties).info));
    else if (event.type === "message.part.updated") this.part(OpenCodePartSchema.parse(z.object({ part: z.unknown() }).parse(event.properties).part));
    else if (event.type === "message.part.delta") this.delta(event.properties);
    else if (event.type === "session.status") {
      const data = z.object({ sessionID: z.string(), status: OpenCodeStatusSchema }).parse(event.properties);
      if (this.own(data.sessionID)) this.status(data.status);
    } else if (event.type === "permission.asked") this.permission(event.properties);
    else if (event.type === "question.asked") this.question(event.properties);
    else if (["permission.replied", "question.replied", "question.rejected"].includes(event.type)) {
      const data = z.object({ sessionID: z.string(), requestID: z.string() }).parse(event.properties);
      if (this.own(data.sessionID)) this.resolve(data.requestID);
    }
  }
  permission(raw: unknown): void {
    const request = OpenCodePermissionSchema.parse(raw);
    if (!this.own(request.sessionID) || !this.value.turn ||
      (request.tool && this.parents.get(request.tool.messageID) !== this.value.turn.id)) return;
    this.pending({ requestId: request.id, rpcId: request.id, kind: "approval", approvalKind: null,
      turnId: this.value.turn.id, itemId: request.tool?.callID ?? request.id, reason: request.permission,
      decisions: ["accept", "acceptForSession", "decline"], questions: [], requestedAt: new Date().toISOString() });
  }
  question(raw: unknown): void {
    const request = OpenCodeQuestionSchema.parse(raw);
    if (!this.own(request.sessionID) || !this.value.turn ||
      (request.tool && this.parents.get(request.tool.messageID) !== this.value.turn.id)) return;
    this.pending({ requestId: request.id, rpcId: request.id, kind: "input", approvalKind: null,
      turnId: this.value.turn.id, itemId: request.tool?.callID ?? request.id, reason: null, decisions: [],
      questions: request.questions.map((question, i) => ({ id: String(i), header: question.header, question: question.question,
        isOther: question.custom !== false, isSecret: false, multiple: question.multiple === true,
        options: question.options })), requestedAt: new Date().toISOString() });
  }
}
