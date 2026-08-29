import { AppError } from "stitchkit";
import { isOwnedCodex } from "../agent/codex/ownedPaths.ts";
import { readOwnedCodexStatus } from "../agent/codex/ownedStatus.ts";
import { nativeResponseFingerprint, readNativeCommand, readNativeReceipt, writeNativeCommand } from "../agent/codex/ownedControl.ts";
import type { MachineConfig } from "../types.ts";
import { ManagedPeerSchema } from "../config/schema.ts";
import { z } from "zod";
import type { ControlPublisher } from "./publisher.ts";
import type { ControlNativeSnapshot } from "./schema.ts";
import { controlTarget } from "./target.ts";

type Target = z.infer<typeof ManagedPeerSchema>;
type Cursor = { generation: string; sequence: number } | null;

export function readControlNative(m: MachineConfig, target: Target, cursor: Cursor): ControlNativeSnapshot {
  const session = controlTarget(m, target);
  if (!isOwnedCodex(session)) throw new AppError("UNSUPPORTED", "Native feed requires an owned App Server session", 409);
  const read = readOwnedCodexStatus(m, session);
  if (read.status !== "live" || read.snapshot === null) throw new AppError("UNAVAILABLE", `Native projection is ${read.reason ?? read.status}`, 503);
  const snapshot = read.snapshot;
  let reset: ControlNativeSnapshot["reset"] = null;
  let items = snapshot.nativeItems;
  if (cursor === null) reset = "initial";
  else if (cursor.generation !== snapshot.generation) reset = "generation";
  else {
    const oldest = snapshot.nativeItems[0]?.sequence ?? snapshot.nativeSequence + 1;
    if (cursor.sequence > snapshot.nativeSequence || cursor.sequence < oldest - 1) reset = "gap";
    else items = snapshot.nativeItems.filter((item) => item.sequence > cursor.sequence);
  }
  return { target, generation: snapshot.generation, sequence: snapshot.nativeSequence, reset,
    observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, items,
    pending: snapshot.pendingRequests.map(({ rpcId: _rpcId, ...pending }) => pending),
    ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }) };
}

export async function* subscribeControlNative(m: MachineConfig, publisher: ControlPublisher, target: Target,
  cursor: Cursor, signal: AbortSignal): AsyncIterable<ControlNativeSnapshot> {
  let next = cursor;
  let last = "";
  for await (const _snapshot of publisher.subscribe(signal)) {
    const frame = readControlNative(m, target, next);
    const fingerprint = `${frame.generation}:${frame.sequence}:${frame.pending.map((item) => item.requestId).join(",")}`;
    if (fingerprint === last) continue;
    last = fingerprint;
    yield frame;
    next = { generation: frame.generation, sequence: frame.sequence };
  }
}

export async function respondControlNative(m: MachineConfig, input: {
  target: Target; operationId: string; generation: string; requestId: string; kind: "approval" | "input";
  decision: "accept" | "acceptForSession" | "decline" | "cancel" | null; answers: Record<string, string[]> | null;
}, signal: AbortSignal) {
  const session = controlTarget(m, input.target);
  if (!isOwnedCodex(session)) throw new AppError("UNSUPPORTED", "Native responses require an owned App Server session", 409);
  const fingerprint = nativeResponseFingerprint(input);
  const prior = readNativeReceipt(m, input.target.session);
  if (prior?.operationId === input.operationId) {
    if (prior.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", "Native response payload changed", 409);
    if (prior.outcome === "submitted") return { operationId: input.operationId, requestId: input.requestId, outcome: "submitted" as const };
    throw new AppError("STALE_REQUEST", prior.reason ?? "Native response was rejected", 409);
  }
  const snapshot = readControlNative(m, input.target, null);
  if (snapshot.generation !== input.generation) throw new AppError("STALE_REQUEST", "Projection generation changed", 409);
  const pending = snapshot.pending.find((item) => item.requestId === input.requestId);
  if (!pending || pending.kind !== input.kind) throw new AppError("STALE_REQUEST", "Native request is not pending", 409);
  const active = readNativeCommand(m, input.target.session);
  if (active !== null && active.operationId !== input.operationId) throw new AppError("BUSY", "Another native response is pending", 429);
  if (active !== null && active.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", "Native response payload changed", 409);
  if (active === null) await writeNativeCommand(m, input.target.session, { operationId: input.operationId,
    generation: input.generation, requestId: input.requestId, fingerprint, kind: input.kind,
    decision: input.decision, answers: input.answers });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const receipt = readNativeReceipt(m, input.target.session);
    if (receipt?.operationId === input.operationId) {
      if (receipt.outcome === "submitted") return { operationId: input.operationId, requestId: input.requestId, outcome: "submitted" as const };
      throw new AppError("STALE_REQUEST", receipt.reason ?? "Native response was rejected", 409);
    }
    await Bun.sleep(25);
  }
  return { operationId: input.operationId, requestId: input.requestId, outcome: "uncertain" as const };
}
