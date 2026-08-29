import { z } from "zod";
import { AppError } from "stitchkit";
import { connectCodexAppServer, type CodexAppRpc } from "../agent/codex/appServer.ts";
import type { CodexRpcOptions } from "../agent/codex/rpc.ts";
import { isOwnedCodex } from "../agent/codex/ownedPaths.ts";
import type { MachineConfig } from "../types.ts";
import { log } from "../util/log.ts";
import { ControlModelCatalogSchema, ControlModelsReadSchema, type ControlModelCatalog } from "./schema.ts";
import { controlTarget } from "./target.ts";

export type ControlModelsConnector = (machine: MachineConfig, options: CodexRpcOptions) => Promise<CodexAppRpc>;
type ModelsReadInput = z.output<typeof ControlModelsReadSchema>;

/** The provider owns this catalog. Only listed safe fields cross the control boundary. */
const ProviderReasoningEffortSchema = z.object({
  reasoningEffort: z.string().min(1).max(64),
  description: z.string().max(1_024),
}).passthrough();
const ProviderServiceTierSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  description: z.string().max(1_024),
}).passthrough();
const ProviderModelSchema = z.object({
  id: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  description: z.string().max(2_048),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.string().min(1).max(64)).max(16),
  serviceTiers: z.array(ProviderServiceTierSchema).max(16),
  supportedReasoningEfforts: z.array(ProviderReasoningEffortSchema).max(32).optional(),
  defaultReasoningEffort: z.string().min(1).max(64).optional(),
}).passthrough();
const ProviderModelPageSchema = z.object({
  data: z.array(ProviderModelSchema).max(64),
  nextCursor: z.string().max(4_096).nullable(),
}).passthrough();

function unavailable(reason: string, error: unknown): never {
  log.debug({ msg: "provider model catalog read failed", reason, err: String(error) });
  throw new AppError("UNAVAILABLE", "Model catalog is unavailable", 503);
}

async function readProviderModels(m: MachineConfig, input: ModelsReadInput, signal: AbortSignal,
  connect: ControlModelsConnector): Promise<ControlModelCatalog> {
  const rpc = await connect(m, { signal, maxMessageBytes: 2 * 1024 * 1024 });
  try {
    const page = ProviderModelPageSchema.parse(await rpc.request("model/list", {
      limit: input.limit,
      ...(input.cursor === null ? {} : { cursor: input.cursor }),
      ...(input.includeHidden ? { includeHidden: true } : {}),
    }));
    return ControlModelCatalogSchema.parse({
      target: input.target,
      data: page.data.map((model) => ({
        id: model.id, displayName: model.displayName, description: model.description,
        hidden: model.hidden, isDefault: model.isDefault, inputModalities: model.inputModalities,
        serviceTiers: model.serviceTiers.map((tier) => ({ id: tier.id, name: tier.name, description: tier.description })),
        ...(model.supportedReasoningEfforts === undefined ? {} : {
          supportedReasoningEfforts: model.supportedReasoningEfforts
            .map((effort) => ({ reasoningEffort: effort.reasoningEffort, description: effort.description })),
        }),
        ...(model.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: model.defaultReasoningEffort }),
      })),
      nextCursor: page.nextCursor,
    });
  } finally {
    rpc.close();
  }
}

/** Read-only `model/list` against the connected App Server of one exact owned session. The caller
 * supplies no registry, credentials, paths, argv or executable configuration; provider failures and
 * malformed pages fail closed instead of substituting a local catalog. */
export async function readControlModels(m: MachineConfig, input: ModelsReadInput, signal: AbortSignal,
  connect: ControlModelsConnector = connectCodexAppServer): Promise<ControlModelCatalog> {
  const session = controlTarget(m, input.target);
  if (!isOwnedCodex(session)) throw new AppError("UNSUPPORTED", "Model catalog requires an owned App Server session", 409);
  try {
    return await readProviderModels(m, input, signal, connect);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError) unavailable("malformed-provider-page", error);
    unavailable("provider-read-failed", error);
  }
}
