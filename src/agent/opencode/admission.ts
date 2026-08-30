import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { MachineConfig, Session } from "../../types.ts";
import { SessionSchema } from "../../config/schema.ts";
import { managedRuntimeRoot } from "../../runtime/status.ts";
import { readPrivateJson } from "../../runtime/store.ts";
import { atomicWrite } from "../../util/atomic.ts";
import { OpenCodeSessionSchema } from "./protocol.ts";
import type { OpenCodeServer } from "./server.ts";

const AdmissionSchema = z.object({ generation: z.uuid(), nativeId: z.string().nullable() }).strict();

/** Persist intent before POST. An uncertain POST is reconciled, never repeated. */
export async function admitOpenCode(m: MachineConfig, initial: Session, server: Pick<OpenCodeServer, "client" | "version">,
  fresh: boolean, signal: AbortSignal): Promise<Session> {
  const path = join(managedRuntimeRoot(m, initial), "admission.json");
  const prior = readPrivateJson(path, AdmissionSchema);
  if (existsSync(path) && prior === null) throw new Error("Native admission journal is invalid");
  const generation = initial.registrationGeneration ?? initial.uuid;
  if (prior !== null && prior.generation !== generation) throw new Error("Native admission generation changed");
  let nativeId = initial.nativeSession?.id ?? prior?.nativeId ?? null;
  if (!fresh && nativeId === null) throw new Error("Native continuation is missing");
  if (nativeId === null && prior !== null) {
    const candidates = z.array(OpenCodeSessionSchema).max(128).parse((await server.client.session.list(
      { directory: initial.dir, search: generation, limit: 128 }, { signal })).data);
    const matching = candidates.filter((session) => session.metadata?.ccmuxRegistration === generation);
    if (matching.length !== 1) throw new Error("Native admission cannot be reconciled unambiguously");
    nativeId = matching[0]?.id ?? null;
  }
  if (nativeId === null) {
    await atomicWrite(path, JSON.stringify({ generation, nativeId: null }), 0o600);
    const created = OpenCodeSessionSchema.parse((await server.client.session.create({
      title: `CCMux ${generation}`, metadata: { ccmuxRegistration: generation },
      ...(initial.modelSelection === undefined ? {} : { model: {
        id: initial.modelSelection.model, providerID: initial.modelSelection.provider } }),
    }, { signal })).data);
    nativeId = created.id;
    await atomicWrite(path, JSON.stringify({ generation, nativeId }), 0o600);
  }
  const native = OpenCodeSessionSchema.parse((await server.client.session.get({ sessionID: nativeId }, { signal })).data);
  if (native.id !== nativeId || realpathSync(native.directory) !== realpathSync(initial.dir) ||
      native.metadata?.ccmuxRegistration !== generation) throw new Error("Native continuation identity or workspace mismatch");
  if (initial.modelSelection && (native.model?.id !== initial.modelSelection.model || native.model.providerID !== initial.modelSelection.provider))
    throw new Error("Native admission changed the selected provider or model");
  return SessionSchema.parse({ ...initial, nativeSession: { runtime: "opencode", id: native.id, version: server.version } });
}
