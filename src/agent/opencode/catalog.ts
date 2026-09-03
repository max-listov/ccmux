import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { ModelSelection } from '../../config/modelSelectionFlags.ts';
import {
  type ControlModel,
  type ControlModelCatalog,
  ControlModelSchema,
  type ControlModelsRead,
} from '../../control/schema.ts';
import { HOME } from '../../env.ts';
import { recordRuntimeDiagnostic } from '../../runtime/diagnostics.ts';
import { modelSelectionLabel } from '../../runtime/selectionSchema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../../runtime/status.ts';
import { readPrivateJson } from '../../runtime/store.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { type OpenCodeClient, startOpenCodeServer } from './server.ts';

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  capabilities: z.object({ input: z.record(z.string(), z.boolean()) }),
  variants: z.record(z.string(), z.unknown()).optional(),
});
const CatalogSchema = z.object({
  providers: z
    .array(z.object({ id: z.string(), models: z.record(z.string(), ModelSchema) }))
    .max(128),
  default: z.record(z.string(), z.string()),
});
const ModelsSchema = z.array(ControlModelSchema).max(4096);
const AgentsSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(128),
      mode: z.enum(['subagent', 'primary', 'all']),
      hidden: z.boolean().nullish(),
    }),
  )
  .max(128);
const PreparedCatalogSchema = z
  .object({
    registrationGeneration: z.uuid(),
    models: ModelsSchema,
    agents: z.array(z.string().min(1).max(128)).max(128),
  })
  .strict();
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'models.json');

export async function nativeOpenCodeModels(
  client: OpenCodeClient,
  signal: AbortSignal,
): Promise<ControlModel[]> {
  const catalog = CatalogSchema.parse((await client.config.providers(undefined, { signal })).data);
  return ModelsSchema.parse(
    catalog.providers
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          provider: provider.id,
          id: model.id,
          model: model.id,
          displayName: model.name.slice(0, 256),
          description: '',
          hidden: model.status === 'deprecated',
          isDefault: catalog.default[provider.id] === model.id,
          inputModalities: Object.entries(model.capabilities.input)
            .filter(([, supported]) => supported)
            .map(([kind]) => kind),
          serviceTiers: [],
          variants: Object.keys(model.variants ?? {}).sort(),
        })),
      )
      .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)),
  );
}
export async function prepareOpenCodeCatalog(
  m: MachineConfig,
  s: Session,
  client: OpenCodeClient,
  signal: AbortSignal,
): Promise<void> {
  const models = await nativeOpenCodeModels(client, signal);
  const agents = AgentsSchema.parse((await client.app.agents(undefined, { signal })).data)
    .filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
    .map((agent) => agent.name)
    .sort();
  const bytes = JSON.stringify(
    PreparedCatalogSchema.parse({
      registrationGeneration: s.registrationGeneration,
      models,
      agents,
    }),
  );
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
    throw new Error('Native catalog exceeds its bounded projection');
  await atomicWrite(path(m, s), bytes, 0o600);
}
export function preparedOpenCodeChoices(m: MachineConfig, s: Session) {
  const value = readPrivateJson(path(m, s), PreparedCatalogSchema, 2 * 1024 * 1024);
  if (
    value === null ||
    value.registrationGeneration !== s.registrationGeneration ||
    readManagedRuntimeStatus(m, s).status !== 'live'
  )
    throw new AppError('UNAVAILABLE', 'Native runtime catalog is unavailable', 503);
  return value;
}
async function hostCatalog(
  m: MachineConfig,
  workspace: string,
  signal: AbortSignal,
): Promise<ControlModel[]> {
  const server = await startOpenCodeServer(m, { dir: workspace }, signal);
  try {
    return await nativeOpenCodeModels(server.client, signal);
  } catch (error) {
    await recordRuntimeDiagnostic(m, null, 'model-catalog', error, server.stderr());
    throw new AppError('UNAVAILABLE', 'Native model catalog is unavailable', 503);
  } finally {
    await server.close();
  }
}
export async function validateOpenCodeSelection(
  m: MachineConfig,
  workspace: string,
  selection: ModelSelection,
  signal: AbortSignal,
): Promise<void> {
  const models = await hostCatalog(m, workspace, signal);
  if (
    !models.some(
      (model) =>
        model.provider === selection.provider && model.id === selection.model && !model.hidden,
    )
  )
    throw new AppError(
      'MODEL_UNAVAILABLE',
      `Model ${modelSelectionLabel(selection)} is unavailable for this runtime`,
      409,
    );
}
export async function readOpenCodeModels(
  m: MachineConfig,
  input: ControlModelsRead,
  session: Session | undefined,
  signal: AbortSignal,
): Promise<ControlModelCatalog> {
  if (input.launchRecipe !== undefined)
    throw new AppError('UNSUPPORTED', 'This runtime does not accept a Codex launch recipe', 409);
  if (session !== undefined && readManagedRuntimeStatus(m, session).status !== 'live')
    throw new AppError('UNAVAILABLE', 'Native runtime catalog is unavailable', 503);
  const prepared = session === undefined ? null : preparedOpenCodeChoices(m, session);
  const models = prepared?.models ?? (await hostCatalog(m, HOME, signal));
  const visible = input.includeHidden ? models : models.filter((model) => !model.hidden);
  const digest = createHash('sha256').update(JSON.stringify(visible)).digest('hex').slice(0, 16);
  let offset = 0;
  if (input.cursor) {
    const [revision, start] = input.cursor.split(':');
    if (revision !== digest || !start || !/^\d+$/.test(start) || Number(start) > visible.length)
      throw new AppError('INVALID_CURSOR', 'Native catalog cursor requires a fresh baseline', 409);
    offset = Number(start);
  }
  const limit = input.limit ?? 64;
  return {
    ...(input.target === undefined ? {} : { target: input.target }),
    source: {
      kind: session === undefined ? 'host' : 'session',
      machine: m.rcPrefix,
      runtime: 'opencode',
      provider: null,
      // OpenCode names its own providers; there is no separate server label behind them.
      providerLabel: null,
      // Computed on the spot from what the host declares, so there is no observation to date.
      observedAt: null,
      freshness: null,
    },
    ...(prepared === null ? {} : { agents: prepared.agents }),
    data: visible.slice(offset, offset + limit),
    nextCursor: offset + limit < visible.length ? `${digest}:${offset + limit}` : null,
  };
}
