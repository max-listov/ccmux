import type { MachineConfig, Session } from "../types.ts";
import { withNativeAdmission } from "../runtime/admission.ts";
import { readManagedRuntimeStatus } from "../runtime/status.ts";
import { recordRuntimeDiagnostic } from "../runtime/diagnostics.ts";
import { AppError } from "stitchkit";
import { NativeHistoryPageSchema, type NativeHistoryPage, type NativeHistoryQuery } from "./schema.ts";
import { readHistoryMailbox, writeHistoryMailbox } from "./service.ts";
import { withContextJournal, readContextJournal } from "./store.ts";

export interface NativeContextApi {
  history(query: NativeHistoryQuery, signal: AbortSignal): Promise<NativeHistoryPage>;
  compactionMarker(signal: AbortSignal): Promise<string | null>;
  compact(signal: AbortSignal): Promise<void>;
}

/** One owner task runs independently of status/approval ticks; shutdown cancels and joins it. */
export class NativeContextPump {
  private abort = new AbortController();
  private task: Promise<void> | null = null;
  constructor(private onError: (error: unknown) => void) {}
  start(signal: AbortSignal, run: (signal: AbortSignal) => Promise<void>): void {
    if (this.abort.signal.aborted || signal.aborted || this.task !== null) return;
    const combined = AbortSignal.any([signal, this.abort.signal]);
    this.task = run(combined).catch(error => {
      if (!combined.aborted) this.onError(error);
    }).finally(() => { this.task = null; });
  }
  async close(): Promise<void> { this.abort.abort(); await this.task; }
}
/** Called by the owner event observer; ACK, idle, disconnect and generation changes never complete a mutation. */
export async function observeContextCompletion(m: MachineConfig, s: Session, generation: string, completionId?: string,
  publishBoundary?: () => Promise<void>): Promise<void> {
  await withContextJournal(m, s, async (journal, persist) => {
    if (completionId !== undefined && journal.lastCompletion?.generation === generation && journal.lastCompletion.id === completionId) return;
    const operation = journal.operations.find(row => row.generation === generation && ["dispatching", "running", "uncertain"].includes(row.state));
    if (operation && completionId !== undefined && completionId === operation.markerBefore) return;
    if (!operation && (completionId === undefined || readManagedRuntimeStatus(m, s).snapshot?.generation !== generation)) return;
    await publishBoundary?.();
    journal.revision++;
    if (operation) { operation.state = "completed"; operation.updatedAt = Date.now(); operation.revision = journal.revision; }
    if (completionId !== undefined) journal.lastCompletion = { generation, id: completionId };
    await persist();
  });
}
async function history(m: MachineConfig, s: Session, generation: string, api: NativeContextApi, signal: AbortSignal): Promise<void> {
  const request = readHistoryMailbox(m, s);
  if (!request || request.state !== "queued") return;
  if (request.generation !== generation || request.expiresAt <= Date.now()) {
    await writeHistoryMailbox(m, s, { ...request, state: "failed", page: null }); return;
  }
  try {
    const revision = readContextJournal(m, s).revision;
    const page = NativeHistoryPageSchema.parse(await api.history(request.query, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, request.expiresAt - Date.now()))])));
    if (page.revision !== revision || readContextJournal(m, s).revision !== revision)
      throw new AppError("HISTORY_CURSOR", "Native context changed during history read", 409);
    if (readHistoryMailbox(m, s)?.id === request.id) await writeHistoryMailbox(m, s, { ...request, state: "complete", page });
  } catch (error) {
    await recordRuntimeDiagnostic(m, s.name, "native-history", error);
    if (readHistoryMailbox(m, s)?.id === request.id) await writeHistoryMailbox(m, s, { ...request, state: "failed", page: null,
      error: error instanceof AppError && error.code === "HISTORY_CURSOR" ? "HISTORY_CURSOR" : "HISTORY_UNAVAILABLE" });
  }
}
/** Pump owns admission; callers must not invoke it while holding the same native admission lock. */
export async function applyContextCommands(m: MachineConfig, s: Session, generation: string, api: NativeContextApi, signal: AbortSignal,
  publishBoundary?: () => Promise<void>): Promise<void> {
  await history(m, s, generation, api, signal);
  const active = readContextJournal(m, s).operations.find(row => !["completed", "rejected"].includes(row.state));
  if (!active) return;
  await withNativeAdmission(m, s, async () => {
    if (active.state !== "queued") {
      try {
        const marker = await api.compactionMarker(signal);
        if (marker !== null && marker !== active.markerBefore) {
          await observeContextCompletion(m, s, active.generation, marker, publishBoundary); return;
        }
      } catch (error) { await recordRuntimeDiagnostic(m, s.name, "context-reconcile", error); }
      if (active.generation !== generation) await withContextJournal(m, s, async (journal, persist) => {
        const row = journal.operations.find(item => item.operationId === active.operationId);
        if (row && row.state !== "completed") { row.state = "uncertain"; row.updatedAt = Date.now(); await persist(); }
      });
      return;
    }
    const status = readManagedRuntimeStatus(m, s);
    if (active.generation !== generation || status.status !== "live" || status.snapshot?.state !== "idle"
      || status.snapshot.turn?.status === "inProgress" || status.snapshot.pendingRequests.length !== 0) {
      await withContextJournal(m, s, async (journal, persist) => {
        const row = journal.operations.find(item => item.operationId === active.operationId);
        if (row?.state === "queued") { row.state = "rejected"; row.updatedAt = Date.now(); await persist(); }
      }); return;
    }
    const marker = await api.compactionMarker(signal);
    signal.throwIfAborted();
    await withContextJournal(m, s, async (journal, persist) => {
      const row = journal.operations.find(item => item.operationId === active.operationId);
      if (row?.state !== "queued") throw new Error("Context admission changed");
      row.state = "dispatching"; row.markerBefore = marker; row.updatedAt = Date.now(); await persist();
    });
    try {
      await api.compact(signal);
      await withContextJournal(m, s, async (journal, persist) => {
        const row = journal.operations.find(item => item.operationId === active.operationId);
        if (row?.state === "dispatching") { row.state = "running"; row.updatedAt = Date.now(); await persist(); }
      });
    } catch (error) {
      await recordRuntimeDiagnostic(m, s.name, "native-compact", error);
      await withContextJournal(m, s, async (journal, persist) => {
        const row = journal.operations.find(item => item.operationId === active.operationId);
        if (row?.state === "dispatching") { row.state = "uncertain"; row.updatedAt = Date.now(); await persist(); }
      });
    }
  });
}
