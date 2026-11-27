import { isAbsolute } from 'node:path';
import { AppError } from 'stitchkit';
import type { CodexControlClient, CodexControlConnection } from 'stitchkit/agent-executor/codex';
import { z } from 'zod';
import { readAntigravityModels } from '../agent/antigravity/catalog.ts';
import { readClaudeModels } from '../agent/claude/native/catalog.ts';
import { nativeModelProvider, withCodexCatalogRuntime } from '../agent/codex/catalogRuntime.ts';
import { type CodexControlConnectOptions, connectOwnedCodex } from '../agent/codex/owned/rpc.ts';
import { readCustomModels } from '../agent/custom/catalog.ts';
import { expandHome } from '../agent/launch/launchInputs.ts';
import { readOpenCodeModels } from '../agent/opencode/catalog.ts';
import { resolveControlLaunchRecipe } from '../config/launchRecipes.ts';
import { recordRuntimeDiagnostic } from '../runtime/diagnostics.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { MachineConfig, Session } from '../types.ts';
import { log } from '../util/log.ts';
import {
  type ControlModelCatalog,
  ControlModelCatalogSchema,
  type ControlModelsReadSchema,
} from './schema/model.ts';
import { refusals } from './schema/refusals.ts';
import { controlTarget } from './target.ts';

export type ControlModelsClient = Pick<
  CodexControlConnection,
  'readConfig' | 'listModels' | 'close'
>;

export type ControlModelsConnector = (
  machine: MachineConfig,
  options: CodexControlConnectOptions,
  session: Session,
) => Promise<ControlModelsClient>;
type ModelsReadInput = z.output<typeof ControlModelsReadSchema>;

/** The provider owns this catalog. Only listed safe fields cross the control boundary. */
const ProviderReasoningEffortSchema = z.looseObject({
  reasoningEffort: z.string().min(1).max(64),
  description: z.string().max(1_024),
});
const ProviderServiceTierSchema = z.looseObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  description: z.string().max(1_024),
});
const ProviderModelSchema = z.looseObject({
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
});
const ProviderModelPageSchema = z.looseObject({
  data: z.array(ProviderModelSchema).max(64),
  nextCursor: z.string().max(4_096).nullable(),
});

function unavailable(reason: string, error: unknown): never {
  log.debug({ msg: 'provider model catalog read failed', reason, err: String(error) });
  throw refusals.errors.UNAVAILABLE({ message: 'Model catalog is unavailable' });
}

async function readProviderModels(
  controls: Pick<CodexControlClient, 'listModels'>,
  input: ModelsReadInput,
  source: ControlModelCatalog['source'],
): Promise<ControlModelCatalog> {
  if (source.provider !== 'openai')
    throw refusals.errors.UNSUPPORTED({
      message: 'This provider does not expose a supported model catalog',
    });
  const page = ProviderModelPageSchema.parse(
    await controls.listModels({
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
      throw refusals.errors.IDENTITY_MISMATCH({
        message: 'Model runtime does not match the managed identity',
      });
    const runtime = target?.agent ?? input.runtime ?? 'codex';
    if (input.profile !== undefined && (runtime !== 'claude' || target !== undefined))
      throw refusals.errors.UNSUPPORTED({
        message: 'Choose a named profile for a Claude host catalog',
      });
    if (runtime === 'antigravity') return await readAntigravityModels(m, input, target, signal);
    if (runtime === 'opencode') return await readOpenCodeModels(m, input, target, signal);
    if (runtime === 'custom') return readCustomModels(m, input, target);
    if (runtime === 'claude') return await readClaudeModels(m, input, target, signal);
    if (runtime !== 'codex')
      throw refusals.errors.UNSUPPORTED({
        message: 'This runtime does not expose a model catalog',
      });
    if (input.target !== undefined) {
      const session = controlTarget(m, input.target);
      if (!hasNativeRuntime(session))
        throw refusals.errors.UNSUPPORTED({
          message: 'Model catalog requires an owned App Server session',
        });
      const controls = await connect(m, { signal, maxFrameBytes: 2 * 1024 * 1024 }, session);
      try {
        return await readProviderModels(controls, input, {
          kind: 'session',
          runtime: 'codex',
          machine: m.rcPrefix,
          provider: await nativeModelProvider(controls),
          providerLabel: null,
          observedAt: null,
          freshness: null,
          ...(session.launchRecipe === undefined ? {} : { launchRecipe: session.launchRecipe }),
        });
      } finally {
        await controls.close().catch(() => {});
      }
    }
    if (m.codexHome === undefined) throw new Error('Codex home is not configured');
    const launch = resolveControlLaunchRecipe(m, m.codexHome, input.launchRecipe, []);
    if (launch.envFile !== undefined && !isAbsolute(expandHome(launch.envFile)))
      throw refusals.errors.PRECONDITION_FAILED({
        message: 'Host catalog requires a host-scoped environment source',
      });
    return await withCodexCatalogRuntime(m, launch, m.codexHome, signal, async (controls) =>
      readProviderModels(controls, input, {
        kind: 'host',
        runtime: 'codex',
        machine: m.rcPrefix,
        provider: await nativeModelProvider(controls),
        providerLabel: null,
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
