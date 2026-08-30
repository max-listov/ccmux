import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "stitchkit";
import { ManagedPeerSchema } from "../config/schema.ts";
import { withDirectoryLock } from "../config/registryLock.ts";
import { privateRuntimeDirectory } from "../agent/codex/ownedPaths.ts";
import { readPrivateJson } from "../runtime/store.ts";
import { atomicWrite } from "../util/atomic.ts";
import { recordRuntimeDiagnostic } from "../runtime/diagnostics.ts";
import type { MachineConfig, Session } from "../types.ts";
import { NativeTurnOptionsSchema } from "../runtime/selectionSchema.ts";

export const NativeForkSourceSchema = z.object({ target: ManagedPeerSchema, registration: z.uuid(), generation: z.uuid(),
  nativeId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).nullable(),
  selection: NativeTurnOptionsSchema.optional() }).strict();
const IntentSchema = z.object({ destination: z.uuid(), source: NativeForkSourceSchema,
  state: z.enum(["reserved", "dispatching", "accepted", "uncertain"]), nativeId: z.string().min(1).max(256).nullable() }).strict();
export type NativeForkSource = z.infer<typeof NativeForkSourceSchema>;
export type NativeForkIntent = z.infer<typeof IntentSchema>;
const path = (m: MachineConfig, generation: string) => join(m.stateDir, "native-forks", `${z.uuid().parse(generation)}.json`);
export function readNativeForkIntent(m: MachineConfig, s: Session): NativeForkIntent | null {
  if (!s.registrationGeneration) return null;
  const file = path(m, s.registrationGeneration);
  const row = readPrivateJson(file, IntentSchema);
  if (row === null && existsSync(file)) throw new Error("Native fork admission state is unavailable");
  return row;
}
export async function prepareNativeFork(m: MachineConfig, generation: string, source: NativeForkSource): Promise<void> {
  privateRuntimeDirectory(join(m.stateDir, "native-forks"));
  const file = path(m, generation);
  const prior = readPrivateJson(file, IntentSchema);
  if (prior) {
    if (JSON.stringify(prior.source) !== JSON.stringify(NativeForkSourceSchema.parse(source))) throw new Error("Native fork source changed");
    return;
  }
  if (existsSync(file)) throw new Error("Native fork admission state is unavailable");
  await atomicWrite(file, JSON.stringify(IntentSchema.parse({ destination: generation, source,
    state: "reserved", nativeId: null })), 0o600);
}
export interface NativeForkAdapter<T> {
  fork(source: NativeForkSource, signal: AbortSignal): Promise<T>;
  identity(response: T): string;
  resume(nativeId: string, signal: AbortSignal): Promise<T>;
}
/** Runs only inside the destination-owned native server. A missing ACK never dispatches fork twice. */
export async function admitNativeFork<T>(m: MachineConfig, s: Session, adapter: NativeForkAdapter<T>, signal: AbortSignal): Promise<T> {
  const generation = s.registrationGeneration;
  if (!generation) throw new Error("Native fork registration is missing");
  return withDirectoryLock(`${path(m, generation)}.lock`, async () => {
    const intent = readNativeForkIntent(m, s);
    if (!intent) throw new Error("Native fork intent is missing");
    if (intent.state === "accepted" && intent.nativeId !== null) return adapter.resume(intent.nativeId, signal);
    if (intent.state !== "reserved") throw new AppError("FORK_UNCERTAIN", "Native fork admission requires reconciliation", 409);
    signal.throwIfAborted();
    const persist = (row: NativeForkIntent) => atomicWrite(path(m, generation), JSON.stringify(IntentSchema.parse(row)), 0o600);
    await persist({ ...intent, state: "dispatching" });
    try {
      const response = await adapter.fork(intent.source, signal);
      const nativeId = z.string().min(1).max(256).parse(adapter.identity(response));
      if (nativeId === intent.source.nativeId) throw new Error("Native fork returned its source identity");
      await persist({ ...intent, state: "accepted", nativeId }); return response;
    } catch (error) {
      await persist({ ...intent, state: "uncertain" });
      await recordRuntimeDiagnostic(m, s.name, "native-fork-admission", error);
      throw new AppError("FORK_UNCERTAIN", "Native fork admission requires reconciliation", 409);
    }
  }, "native fork admission");
}
