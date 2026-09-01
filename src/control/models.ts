import { isAbsolute } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { readClaudeModels } from '../agent/claude/native/catalog.ts';

import { nativeModelProvider, withCodexCatalogRuntime } from '../agent/codex/catalogRuntime.ts';
import { isOwnedCodex } from '../agent/codex/ownedPaths.ts';
import { connectOwnedCodex } from '../agent/codex/ownedRpc.ts';
import type { CodexAppRpc, CodexRpcOptions } from '../agent/codex/rpc.ts';
import { readCustomModels } from '../agent/custom/catalog.ts';
import { expandHome } from '../agent/launchInputs.ts';
import { readOpenCodeModels } from '../agent/opencode/catalog.ts';
import { resolveControlLaunchRecipe } from '../config/launchRecipes.ts';
import { recordRuntimeDiagnostic } from '../runtime/diagnostics.ts';
import type { MachineConfig, Session } from '../types.ts';
import { log } from '../util/log.ts';
import {
  type ControlModelCatalog,
  ControlModelCatalogSchema,
  type ControlModelsReadSchema,
} from './schema.ts';
import { controlTarget } from './target.ts';

export type ControlModelsConnector = (
  machine: MachineConfig,
  options: CodexRpcOptions,
  session: Session,
) => Promise<CodexAppRpc>;
type ModelsReadInput = z.output<typeof ControlModelsReadSchema>;

/** The provider owns this catalog. Only listed safe fields cross the control boundary. */
const ProviderReasoningEffortSchema = z
  .object({
    reasoningEffort: z.string().min(1).max(64),
    description: z.string().max(1_024),
  })
  .passthrough();
const ProviderServiceTierSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(256),
    description: z.string().max(1_024),
  })
  .passthrough();
const ProviderModelSchema = z
  .object({
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256).optional(),
    displayName: z.string().min(1).max(256),
    description: z.string().max(2_048),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z.array(z.string().min(1).max(64)).max(16),
    serviceTiers: z.array(ProviderServiceTierSchema).max(16),
    supportedReasoningEfforts: z.array(ProviderReasoningEffortSchema).max(32).optional(),
    defaultReasoningEffort: z.string().min(1).max(64).optional(),
  })
  .passthrough();
const ProviderModelPageSchema = z
  .object({
    data: z.array(ProviderModelSchema).max(64),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .passthrough();

function unavailable(reason: string, error: unknown): never {
  log.debug({ msg: 'provider model catalog read failed', reason, err: String(error) });
  throw new AppError('UNAVAILABLE', 'Model catalog is unavailable', 503);
}

async function readProviderModels(
  rpc: CodexAppRpc,
  input: ModelsReadInput,
  source: ControlModelCatalog['source'],
): Promise<ControlModelCatalog> {
  // Native picker metadata is not an authoritative inventory for an arbitrary custom endpoint.
  // Never label the default catalog as a custom provider's models.
  if (source.provider !== 'openai')
    throw new AppError(
      'UNSUPPORTED',
      'This provider does not expose a supported model catalog',
      409,
    );
  const page = ProviderModelPageSchema.parse(
    await rpc.request('model/list', {
      limit: input.limit,
      ...(input.cursor === null ? {} : { cursor: input.cursor }),
      ...(input.includeHidden ? { includeHidden: true } : {}),
    }),
  );
  return ControlModelCatalogSchema.parse({
    ...(input.target === undefined ? {} : { target: input.target }),
    source,
    data: page.data.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      ...(model.model === undefined ? {} : { model: model.model }),
      hidden: model.hidden,
      isDefault: model.isDefault,
      inputModalities: model.inputModalities,
      serviceTiers: model.serviceTiers.map((tier) => ({
        id: tier.id,
        name: tier.name,
        description: tier.description,
      })),
      ...(model.supportedReasoningEfforts === undefined
        ? {}
        : {
            supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
              reasoningEffort: effort.reasoningEffort,
              description: effort.description,
            })),
          }),
      ...(model.defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort: model.defaultReasoningEffort }),
    })),
    nextCursor: page.nextCursor,
  });
}

/** Host reads need no thread. Session reads connect only to that session's owned runtime. */
export async function readControlModels(
  m: MachineConfig,
  input: ModelsReadInput,
  signal: AbortSignal,
  connect: ControlModelsConnector = (machine, options, session) =>
    connectOwnedCodex(machine, session, options),
): Promise<ControlModelCatalog> {
  try {
    const target = input.target === undefined ? undefined : controlTarget(m, input.target);
    if (input.runtime !== undefined && target !== undefined && input.runtime !== target.agent)
      throw new AppError(
        'IDENTITY_MISMATCH',
        'Model runtime does not match the managed identity',
        409,
      );
    const runtime = target?.agent ?? input.runtime ?? 'codex';
    if (runtime === 'opencode') return await readOpenCodeModels(m, input, target, signal);
    if (runtime === 'custom') return readCustomModels(m, input, target);
    if (runtime === 'claude') return readClaudeModels(m, input, target);
    if (runtime !== 'codex')
      throw new AppError('UNSUPPORTED', 'This runtime does not expose a model catalog', 409);
    if (input.target !== undefined) {
      const session = controlTarget(m, input.target);
      if (!isOwnedCodex(session))
        throw new AppError(
          'UNSUPPORTED',
          'Model catalog requires an owned App Server session',
          409,
        );
      const rpc = await connect(m, { signal, maxMessageBytes: 2 * 1024 * 1024 }, session);
      try {
        return await readProviderModels(rpc, input, {
          kind: 'session',
          runtime: 'codex',
          machine: m.rcPrefix,
          provider: await nativeModelProvider(rpc),
          providerLabel: null,
          // Computed on the spot from what the host declares, so there is no observation to date.
          observedAt: null,
          freshness: null,
          ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }),
        });
      } finally {
        rpc.close();
      }
    }
    if (m.codexHome === undefined) throw new Error('Codex home is not configured');
    const launch = resolveControlLaunchRecipe(m, m.codexHome, input.launchRecipe, []);
    if (launch.envFile !== undefined && !isAbsolute(expandHome(launch.envFile)))
      throw new AppError(
        'UNAVAILABLE',
        'Host catalog requires a host-scoped environment source',
        409,
      );
    return await withCodexCatalogRuntime(m, launch, m.codexHome, signal, async (rpc) =>
      readProviderModels(rpc, input, {
        kind: 'host',
        runtime: 'codex',
        machine: m.rcPrefix,
        provider: await nativeModelProvider(rpc),
        providerLabel: null,
        // Computed on the spot from what the host declares, so there is no observation to date.
        observedAt: null,
        freshness: null,
        ...(launch.launchRecipe === undefined ? {} : { launchRecipe: launch.launchRecipe }),
      }),
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    await recordRuntimeDiagnostic(m, input.target?.session ?? null, 'model-catalog', error);
    if (error instanceof z.ZodError) unavailable('malformed-provider-page', error);
    unavailable('provider-read-failed', error);
  }
}
