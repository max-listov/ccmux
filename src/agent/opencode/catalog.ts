import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "stitchkit";
import type { MachineConfig, Session } from "../../types.ts";
import type { ModelSelection } from "../../config/modelSelectionFlags.ts";
import { ControlModelSchema, type ControlModel, type ControlModelsRead, type ControlModelCatalog } from "../../control/schema.ts";
import { managedRuntimeRoot, readManagedRuntimeStatus } from "../../runtime/status.ts";
import { readPrivateJson } from "../../runtime/store.ts";
import { atomicWrite } from "../../util/atomic.ts";
import { startOpenCodeServer, type OpenCodeClient } from "./server.ts";
import { HOME } from "../../env.ts";
import { recordRuntimeDiagnostic } from "../../runtime/diagnostics.ts";

const ModelSchema = z.object({ id: z.string(), name: z.string(), status: z.string(),
  capabilities: z.object({ input: z.record(z.string(), z.boolean()) }) });
const CatalogSchema = z.object({ providers: z.array(z.object({ id: z.string(), models: z.record(z.string(), ModelSchema) })).max(128),
  default: z.record(z.string(), z.string()) });
const PreparedCatalogSchema = z.array(ControlModelSchema).max(4096);
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), "models.json");

export async function nativeOpenCodeModels(client: OpenCodeClient, signal: AbortSignal): Promise<ControlModel[]> {
  const catalog = CatalogSchema.parse((await client.config.providers(undefined, { signal })).data);
  return PreparedCatalogSchema.parse(catalog.providers.flatMap(provider => Object.values(provider.models).map(model => ({
    provider: provider.id, id: model.id, model: model.id, displayName: model.name.slice(0, 256), description: "",
    hidden: model.status === "deprecated", isDefault: catalog.default[provider.id] === model.id,
    inputModalities: Object.entries(model.capabilities.input).filter(([, supported]) => supported).map(([kind]) => kind), serviceTiers: [],
  }))).sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)));
}
export async function prepareOpenCodeCatalog(m: MachineConfig, s: Session, client: OpenCodeClient, signal: AbortSignal): Promise<void> {
  const bytes = JSON.stringify(await nativeOpenCodeModels(client, signal));
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Native catalog exceeds its bounded projection");
  await atomicWrite(path(m, s), bytes, 0o600);
}
async function hostCatalog(m: MachineConfig, workspace: string, signal: AbortSignal): Promise<ControlModel[]> {
  const server = await startOpenCodeServer(m, { dir: workspace }, signal);
  try { return await nativeOpenCodeModels(server.client, signal); }
  catch (error) {
    await recordRuntimeDiagnostic(m, null, "model-catalog", error, server.stderr());
    throw new AppError("UNAVAILABLE", "Native model catalog is unavailable", 503);
  } finally { await server.close(); }
}
export async function validateOpenCodeSelection(m: MachineConfig, workspace: string, selection: ModelSelection, signal: AbortSignal): Promise<void> {
  const models = await hostCatalog(m, workspace, signal);
  if (!models.some(model => model.provider === selection.provider && model.id === selection.model && !model.hidden))
    throw new AppError("MODEL_UNAVAILABLE", "The selected model is unavailable for this runtime", 409);
}
export async function readOpenCodeModels(m: MachineConfig, input: ControlModelsRead, session: Session | undefined,
  signal: AbortSignal): Promise<ControlModelCatalog> {
  if (input.launchRecipe !== undefined) throw new AppError("UNSUPPORTED", "This runtime does not accept a Codex launch recipe", 409);
  if (session !== undefined && readManagedRuntimeStatus(m, session).status !== "live")
    throw new AppError("UNAVAILABLE", "Native runtime catalog is unavailable", 503);
  const models = session === undefined ? await hostCatalog(m, HOME, signal)
    : readPrivateJson(path(m, session), PreparedCatalogSchema, 2 * 1024 * 1024);
  if (models === null) throw new AppError("UNAVAILABLE", "Native runtime catalog is unavailable", 503);
  const visible = input.includeHidden ? models : models.filter(model => !model.hidden);
  const digest = createHash("sha256").update(JSON.stringify(visible)).digest("hex").slice(0, 16);
  let offset = 0;
  if (input.cursor) {
    const [revision, start] = input.cursor.split(":");
    if (revision !== digest || !start || !/^\d+$/.test(start) || Number(start) > visible.length)
      throw new AppError("INVALID_CURSOR", "Native catalog cursor requires a fresh baseline", 409);
    offset = Number(start);
  }
  const limit = input.limit ?? 64;
  return { ...(input.target === undefined ? {} : { target: input.target }),
    source: { kind: session === undefined ? "host" : "session", machine: m.rcPrefix, runtime: "opencode", provider: null },
    data: visible.slice(offset, offset + limit), nextCursor: offset + limit < visible.length ? `${digest}:${offset + limit}` : null };
}
