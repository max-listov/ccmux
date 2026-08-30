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
import { readSelection, seedNativeSelection } from "../../runtime/selection.ts";
import { verifyApplicationPolicy } from "../../policy/resolve.ts";
import { selectOpenCodePolicyAgent } from "../../policy/opencode.ts";
import { admitNativeFork, readNativeForkIntent } from "../../context/fork.ts";

const AdmissionSchema = z.object({ generation: z.uuid(), nativeId: z.string().nullable() }).strict();

/** Persist intent before POST. An uncertain POST is reconciled, never repeated. */
export async function admitOpenCode(m: MachineConfig, initial: Session, server: Pick<OpenCodeServer, "client" | "version">,
  fresh: boolean, signal: AbortSignal): Promise<Session> {
  if (initial.applicationPolicy !== undefined) {
    const policy = verifyApplicationPolicy(m, "opencode", initial.applicationPolicy);
    selectOpenCodePolicyAgent(policy, (await server.client.app.agents({ directory: initial.dir }, { signal })).data);
  }
  const path = join(managedRuntimeRoot(m, initial), "admission.json");
  const prior = readPrivateJson(path, AdmissionSchema);
  if (existsSync(path) && prior === null) throw new Error("Native admission journal is invalid");
  const generation = initial.registrationGeneration ?? initial.uuid;
  if (prior !== null && prior.generation !== generation) throw new Error("Native admission generation changed");
  let nativeId = initial.nativeSession?.id ?? prior?.nativeId ?? null;
  const fork = readNativeForkIntent(m, initial);
  if (nativeId === null && fork !== null) {
    const native = await admitNativeFork(m, initial, {
      fork: async (source, nativeSignal) => OpenCodeSessionSchema.parse((await server.client.session.fork({
        sessionID: source.nativeId, directory: initial.dir,
      }, { signal: nativeSignal })).data),
      identity: result => result.id,
      resume: async (sessionID, nativeSignal) => OpenCodeSessionSchema.parse((await server.client.session.get({ sessionID }, { signal: nativeSignal })).data),
    }, signal);
    nativeId = native.id;
    await atomicWrite(path, JSON.stringify({ generation, nativeId }), 0o600);
  }
  if (fork !== null && nativeId !== null) {
    // Metadata assignment is idempotent and follows the durable fork ACK; a lost assignment ACK
    // can repeat this update, but must never repeat the native fork itself.
    await server.client.session.update({ sessionID: nativeId, title: `CCMux ${generation}`,
      metadata: { ccmuxRegistration: generation } }, { signal });
    const selected = readSelection(m, initial)?.options ?? fork.source.selection;
    if (selected?.runtime !== "opencode") throw new Error("Native fork selection is unavailable");
    // This typed config operation updates the same SessionTable read by the classic owner.
    // It neither admits input nor wakes the separate v2 agent loop.
    await server.client.v2.session.switchModel({ sessionID: nativeId,
      model: { providerID: selected.model.provider, id: selected.model.model,
        ...(selected.variant === undefined ? {} : { variant: selected.variant }) } }, { signal });
    if (selected.agent !== undefined)
      await server.client.v2.session.switchAgent({ sessionID: nativeId, agent: selected.agent }, { signal });
  }
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
  const retained = readSelection(m, initial);
  if (fresh && retained === null && initial.modelSelection && (native.model?.id !== initial.modelSelection.model || native.model.providerID !== initial.modelSelection.provider))
    throw new Error("Native admission changed the selected provider or model");
  const session = SessionSchema.parse({ ...initial, nativeSession: { runtime: "opencode", id: native.id, version: server.version } });
  if (retained === null) {
    if (native.model === undefined) throw new Error("Native admission did not report its selected model");
    const source = fork?.source.selection;
    await seedNativeSelection(m, session, { runtime: "opencode", model: { provider: native.model.providerID, model: native.model.id },
      ...(source?.runtime === "opencode" && source.agent !== undefined ? { agent: source.agent } : {}),
      ...(source?.runtime === "opencode" && source.variant !== undefined ? { variant: source.variant } : {}) });
  }
  return session;
}
