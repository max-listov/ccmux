import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import {
  type AcpConfigOption,
  acpOptionChoices,
  createAcpDriver,
} from 'stitchkit/agent-executor/acp';
import { z } from 'zod';
import { pageModelCatalog } from '../../control/modelPage.ts';
import type {
  ControlModel,
  ControlModelCatalog,
  ControlModelsRead,
} from '../../control/schema/model.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { modelSelectionLabel, type NativeModelSelection } from '../../runtime/selectionSchema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJson } from '../../runtime/store.ts';
import { loadSessions } from '../../session/registry.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { HOME } from '../../util/env.ts';
import { preflightAntigravity } from './preflight.ts';

const ModelSchema = z
  .object({
    provider: z.string().min(1).max(128),
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    description: z.string().max(2_048),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    inputModalities: z.array(z.string().min(1).max(64)).max(16),
    serviceTiers: z
      .array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict())
      .max(8),
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: z.string(), description: z.string() }).strict())
      .max(32)
      .optional(),
    defaultReasoningEffort: z.string().min(1).max(64).optional(),
  })
  .strict();

const PreparedSchema = z
  .object({
    registrationGeneration: z.uuid(),
    observedAt: z.string().max(64).optional(),
    models: z.array(ModelSchema).max(128),
  })
  .strict();

const MAX_BYTES = 512 * 1024;
const catalogPath = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'models.json');

/** Project ACP `configOptions` (`model` + `thought_level`) into CCMux's unified model catalog rows. */
export function antigravityModelsFromConfigOptions(
  configOptions: readonly AcpConfigOption[],
): ControlModel[] {
  const model = configOptions.find((option) => option.category === 'model');
  if (!model?.options) throw new Error('ACP returned no model choices');
  const effort = configOptions.find((option) => option.category === 'thought_level');
  return acpOptionChoices(model)
    .slice(0, 128)
    .map(({ value: id, name }) => ({
      provider: 'antigravity',
      id,
      model: id,
      displayName: (name ?? id).slice(0, 256),
      description: '',
      hidden: false,
      isDefault: id === model.currentValue,
      // Antigravity ACP declares `promptCapabilities.image: true`; carrying both modalities keeps
      // control-plane image validation aligned with what the driver accepts.
      inputModalities: ['text', 'image'],
      serviceTiers: [],
      // The active model owns these choices. Selecting another model may narrow its options.
      ...(id === model.currentValue && effort
        ? {
            supportedReasoningEfforts: acpOptionChoices(effort)
              .slice(0, 32)
              .map(({ value, name }) => ({
                reasoningEffort: value,
                description: (name ?? value).slice(0, 1_024),
              })),
            ...(effort.currentValue ? { defaultReasoningEffort: effort.currentValue } : {}),
          }
        : {}),
    }));
}

export async function writeAntigravityCatalog(
  m: MachineConfig,
  s: Session,
  configOptions: readonly AcpConfigOption[],
): Promise<ControlModel[]> {
  const models = antigravityModelsFromConfigOptions(configOptions);
  const bytes = JSON.stringify(
    PreparedSchema.parse({
      registrationGeneration: s.registrationGeneration,
      observedAt: new Date().toISOString(),
      models,
    }),
  );
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    throw new Error('Antigravity model catalog exceeds its bounded projection');
  privateRuntimeDirectory(managedRuntimeRoot(m, s));
  await atomicWrite(catalogPath(m, s), bytes, 0o600);
  return models;
}

function cachedSessionCatalog(
  m: MachineConfig,
): { models: readonly ControlModel[]; observedAt: string | null; live: boolean } | null {
  let best: { models: readonly ControlModel[]; observedAt: string | null; live: boolean } | null =
    null;
  for (const candidate of loadSessions(m)) {
    if (candidate.agent !== 'antigravity' || !hasNativeRuntime(candidate)) continue;
    const file = catalogPath(m, candidate);
    const prepared = readPrivateJson(file, PreparedSchema, MAX_BYTES);
    if (prepared === null) continue;
    let observedAt = prepared.observedAt ?? null;
    if (observedAt === null) {
      try {
        observedAt = statSync(file).mtime.toISOString();
      } catch {
        observedAt = null;
      }
    }
    const live = readManagedRuntimeStatus(m, candidate).status === 'live';
    const better =
      best === null ||
      (live && !best.live) ||
      (live === best.live && (observedAt ?? '') > (best.observedAt ?? ''));
    if (better) best = { models: prepared.models, observedAt, live };
  }
  return best;
}

/** Probe a fresh private ACP metadata session without running inference or registering a session. */
export async function probeAntigravityHostModels(
  machine: MachineConfig,
  signal: AbortSignal,
): Promise<{ models: ControlModel[]; observedAt: string }> {
  let executable: string;
  try {
    executable = preflightAntigravity(machine);
  } catch (error) {
    throw new AppError('UNAVAILABLE', {
      message: error instanceof Error ? error.message : 'Antigravity CLI is unavailable',
      status: 503,
    });
  }
  const driver = createAcpDriver({
    executable,
    args: ['acp', '--stdio', '--process-per-session', '--sandbox'],
    requestTimeoutMs: 25_000,
  });
  // The metadata worker gets an empty workspace, never the whole shared temp directory.
  const cwd = await mkdtemp(join(tmpdir(), 'ccmux-acp-'));
  try {
    const probe = await driver.probeCapabilities({
      profile: { engine: 'acp', profileId: 'local', home: HOME },
      cwd,
      signal,
    });
    return {
      models: antigravityModelsFromConfigOptions(probe.configOptions),
      observedAt: new Date().toISOString(),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Refuse an unknown model ID before creating a session receipt or spawning the managed owner. */
export async function validateAntigravitySelection(
  m: MachineConfig,
  selection: NativeModelSelection,
  signal: AbortSignal,
): Promise<void> {
  if (selection.provider !== 'antigravity')
    throw new AppError('MODEL_UNAVAILABLE', {
      message: `Model ${modelSelectionLabel(selection)} is absent from this host's catalog`,
      status: 409,
    });
  const cached = cachedSessionCatalog(m);
  const models = cached ? cached.models : (await probeAntigravityHostModels(m, signal)).models;
  if (!models.some((row) => (row.model ?? row.id) === selection.model))
    throw new AppError('MODEL_UNAVAILABLE', {
      message: `Model ${modelSelectionLabel(selection)} is absent from this host's catalog`,
      status: 409,
    });
}

/** Read Antigravity models for a host (before create) or for a live managed session. */
export async function readAntigravityModels(
  machine: MachineConfig,
  input: ControlModelsRead,
  session: Session | undefined,
  signal: AbortSignal,
): Promise<ControlModelCatalog> {
  if (input.launchRecipe !== undefined)
    throw new AppError('UNSUPPORTED', {
      message: 'This runtime does not accept a Codex launch recipe',
      status: 409,
    });
  if (session !== undefined) {
    const prepared = readPrivateJson(catalogPath(machine, session), PreparedSchema, MAX_BYTES);
    if (
      prepared === null ||
      prepared.registrationGeneration !== session.registrationGeneration ||
      readManagedRuntimeStatus(machine, session).status !== 'live'
    )
      throw new AppError('UNAVAILABLE', {
        message: 'Native runtime catalog is unavailable',
        status: 503,
      });
    return pageModelCatalog(
      prepared.models,
      input,
      {
        kind: 'session',
        machine: machine.rcPrefix,
        provider: 'antigravity',
        providerLabel: null,
        runtime: 'antigravity',
        observedAt: prepared.observedAt ?? null,
        freshness: 'live',
      },
      input.target,
    );
  }
  const probed = await probeAntigravityHostModels(machine, signal);
  return pageModelCatalog(probed.models, input, {
    kind: 'host',
    machine: machine.rcPrefix,
    provider: 'antigravity',
    providerLabel: null,
    runtime: 'antigravity',
    observedAt: probed.observedAt,
    freshness: 'live',
  });
}
