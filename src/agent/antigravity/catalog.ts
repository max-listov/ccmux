import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AcpConfigOption,
  acpOptionChoices,
  createAcpDriver,
} from 'stitchkit/agent-executor/acp';
import { z } from 'zod';
import {
  type AntigravityProfileBinding,
  isAntigravityProfileBinding,
} from '../../config/antigravityProfileSchema.ts';
import { pageModelCatalog } from '../../control/modelPage.ts';
import type {
  ControlModel,
  ControlModelCatalog,
  ControlModelsRead,
} from '../../control/schema/model.ts';
import { refusals } from '../../control/schema/refusals.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { modelSelectionLabel, type NativeModelSelection } from '../../runtime/selectionSchema.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../../runtime/status.ts';
import { privateRuntimeDirectory, readPrivateJson } from '../../runtime/store.ts';
import { loadSessions } from '../../session/registry.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { atomicWrite } from '../../util/atomic.ts';
import { HOME } from '../../util/home.ts';
import {
  antigravityLaunchOptions,
  antigravityProfileId,
  selectAntigravityProfile,
} from './namedProfiles.ts';
import {
  ANTIGRAVITY_MIN_VERSION,
  ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
  preflightAntigravity,
} from './preflight.ts';

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
    tierName: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

const MAX_BYTES = 512 * 1024;
const catalogPath = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'models.json');

/**
 * How long a host probe answers later host reads. A probe spawns `agy acp` for seconds; the
 * installed CLI's catalog changes with an upgrade, not between two reads.
 */
export const HOST_CATALOG_TTL_MS = 10 * 60_000;
const HostCatalogSchema = z
  .object({
    observedAt: z.iso.datetime(),
    models: z.array(ModelSchema).max(128),
    tierName: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

const AntigravitySessionMetaSchema = z.object({
  antigravity: z
    .object({
      tier: z
        .object({
          name: z.string().min(1).max(64).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Extract `_meta.antigravity.tier.name` from ACP session metadata when the executor exposes it. */
export function antigravityTierName(sessionMeta: unknown): string | null {
  const parsed = AntigravitySessionMetaSchema.safeParse(sessionMeta);
  const name = parsed.data?.antigravity?.tier?.name?.trim() ?? '';
  return name === '' ? null : name.slice(0, 64);
}

const hostCatalogDir = (m: MachineConfig) => join(m.stateDir, 'native-runtime');
const hostCatalogPath = (m: MachineConfig, profileId = 'default') =>
  join(
    hostCatalogDir(m),
    profileId === 'default'
      ? 'antigravity-host-models.json'
      : `antigravity-host-models-${profileId}.json`,
  );

async function writeHostCatalog(
  m: MachineConfig,
  catalog: { models: ControlModel[]; observedAt: string; tierName?: string | null },
  profileId = 'default',
): Promise<void> {
  privateRuntimeDirectory(hostCatalogDir(m));
  await atomicWrite(
    hostCatalogPath(m, profileId),
    JSON.stringify(HostCatalogSchema.parse(catalog)),
    0o600,
  );
}

/** The last host probe while it is younger than `HOST_CATALOG_TTL_MS`, else null. */
export function freshHostCatalog(
  m: MachineConfig,
  now = Date.now(),
  profileId = 'default',
): { models: ControlModel[]; observedAt: string; tierName?: string | null | undefined } | null {
  const cached = readPrivateJson(hostCatalogPath(m, profileId), HostCatalogSchema, MAX_BYTES);
  if (cached === null) return null;
  const age = now - Date.parse(cached.observedAt);
  return age >= 0 && age < HOST_CATALOG_TTL_MS ? cached : null;
}

/** Cached Antigravity plan tier name from the host ACP catalog or a session catalog for the same profile. */
export function cachedAntigravityTier(m: MachineConfig, profileId = 'default'): string | null {
  const cached = readPrivateJson(hostCatalogPath(m, profileId), HostCatalogSchema, MAX_BYTES);
  if (cached?.tierName) return cached.tierName;
  let best: { tierName: string; observedAt: string; live: boolean } | null = null;
  for (const candidate of loadSessions(m)) {
    if (candidate.agent !== 'antigravity' || !hasNativeRuntime(candidate)) continue;
    const candidateProfile = isAntigravityProfileBinding(candidate.profile)
      ? candidate.profile
      : undefined;
    if (antigravityProfileId(candidateProfile) !== profileId) continue;
    const prepared = readPrivateJson(catalogPath(m, candidate), PreparedSchema, MAX_BYTES);
    if (!prepared?.tierName) continue;
    const observedAt = prepared.observedAt ?? '';
    const live = readManagedRuntimeStatus(m, candidate).status === 'live';
    const better =
      best === null || (live && !best.live) || (live === best.live && observedAt > best.observedAt);
    if (better) best = { tierName: prepared.tierName, observedAt, live };
  }
  return best?.tierName ?? null;
}

/**
 * Project ACP `configOptions` (`model` + `thought_level`) into Stitchmux's unified model catalog rows.
 *
 * `images` is the agent's own `promptCapabilities.image` from `initialize`. ACP declares input
 * modalities for the agent, not per model, so every row carries what the agent declared — nothing
 * more is known, and nothing more is claimed.
 *
 * The agent describes `thought_level` for the model that is selected. `optionsByModel` is what it
 * answered with each model selected in turn (a host probe's `eachModel`): a model whose answer has no
 * `thought_level` gets no reasoning efforts. Without it — a live session's options — only the active
 * model's choices are known, and only that row carries them.
 */
export function antigravityModelsFromConfigOptions(
  configOptions: readonly AcpConfigOption[],
  images: boolean,
  optionsByModel?: Readonly<Record<string, readonly AcpConfigOption[]>>,
): ControlModel[] {
  const model = configOptions.find((option) => option.category === 'model');
  if (!model?.options) throw new Error('ACP returned no model choices');
  const effortOf = (id: string) =>
    (optionsByModel
      ? optionsByModel[id]
      : id === model.currentValue
        ? configOptions
        : undefined
    )?.find((option) => option.category === 'thought_level');
  return acpOptionChoices(model)
    .slice(0, 128)
    .map(({ value: id, name }) => {
      const effort = effortOf(id);
      return {
        provider: 'antigravity',
        id,
        model: id,
        displayName: (name ?? id).slice(0, 256),
        description: '',
        hidden: false,
        isDefault: id === model.currentValue,
        inputModalities: images ? ['text', 'image'] : ['text'],
        serviceTiers: [],
        ...(effort
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
      };
    });
}

export async function writeAntigravityCatalog(
  m: MachineConfig,
  s: Session,
  configOptions: readonly AcpConfigOption[],
  images: boolean,
  sessionMeta?: unknown,
): Promise<ControlModel[]> {
  const models = antigravityModelsFromConfigOptions(configOptions, images);
  const tierName = antigravityTierName(sessionMeta);
  const bytes = JSON.stringify(
    PreparedSchema.parse({
      registrationGeneration: s.registrationGeneration,
      observedAt: new Date().toISOString(),
      models,
      ...(tierName === null ? {} : { tierName }),
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
  profile?: AntigravityProfileBinding,
): { models: readonly ControlModel[]; observedAt: string | null; live: boolean } | null {
  let best: { models: readonly ControlModel[]; observedAt: string | null; live: boolean } | null =
    null;
  const targetId = antigravityProfileId(profile);
  for (const candidate of loadSessions(m)) {
    if (candidate.agent !== 'antigravity' || !hasNativeRuntime(candidate)) continue;
    const candidateProfile = isAntigravityProfileBinding(candidate.profile)
      ? candidate.profile
      : undefined;
    if (
      antigravityProfileId(candidateProfile) !== targetId ||
      candidateProfile?.accountDigest !== profile?.accountDigest
    )
      continue;
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
  profile?: AntigravityProfileBinding,
): Promise<{ models: ControlModel[]; observedAt: string; tierName?: string | null }> {
  const launch = antigravityLaunchOptions(machine, profile);
  let executable: string;
  try {
    executable = await preflightAntigravity(machine, [], {
      minVersion: launch.forceFileStorage
        ? ANTIGRAVITY_MULTIPROFILE_MIN_VERSION
        : ANTIGRAVITY_MIN_VERSION,
      dataDir: launch.dataDir,
    });
  } catch (error) {
    throw refusals.errors.UNAVAILABLE({
      message: error instanceof Error ? error.message : 'Antigravity CLI is unavailable',
    });
  }
  const driver = createAcpDriver({
    executable,
    args: ['acp', '--stdio', '--process-per-session', '--sandbox', ...launch.dirFlags],
    requestTimeoutMs: 25_000,
  });
  // The metadata worker gets an empty workspace, never the whole shared temp directory.
  const cwd = await mkdtemp(join(tmpdir(), 'stitchmux-acp-'));
  try {
    const probe = await driver.probeCapabilities({
      profile: {
        engine: 'acp',
        profileId: launch.profileId,
        home: HOME,
        ...(Object.keys(launch.extraEnv).length === 0 ? {} : { env: launch.extraEnv }),
      },
      cwd,
      signal,
      eachModel: true,
    });
    const tierName = antigravityTierName(probe.sessionMeta);
    const probed = {
      models: antigravityModelsFromConfigOptions(
        probe.configOptions,
        probe.initialized.agentCapabilities?.promptCapabilities?.image === true,
        probe.optionsByModel,
      ),
      observedAt: new Date().toISOString(),
      ...(tierName === null ? {} : { tierName }),
    };
    await writeHostCatalog(machine, probed, launch.profileId);
    return probed;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Refuse an unknown model ID before creating a session receipt or spawning the managed owner. */
export async function validateAntigravitySelection(
  m: MachineConfig,
  selection: NativeModelSelection,
  signal: AbortSignal,
  profile?: AntigravityProfileBinding,
): Promise<void> {
  if (selection.provider !== 'antigravity')
    throw refusals.errors.MODEL_UNAVAILABLE({
      message: `Model ${modelSelectionLabel(selection)} is absent from this host's catalog`,
    });
  const profileId = antigravityProfileId(profile);
  const cached = cachedSessionCatalog(m, profile) ?? freshHostCatalog(m, Date.now(), profileId);
  const models = cached
    ? cached.models
    : (await probeAntigravityHostModels(m, signal, profile)).models;
  if (!models.some((row) => (row.model ?? row.id) === selection.model))
    throw refusals.errors.MODEL_UNAVAILABLE({
      message: `Model ${modelSelectionLabel(selection)} is absent from this host's catalog`,
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
    throw refusals.errors.UNSUPPORTED({
      message: 'This runtime does not accept a Codex launch recipe',
    });
  if (session !== undefined) {
    const prepared = readPrivateJson(catalogPath(machine, session), PreparedSchema, MAX_BYTES);
    if (
      prepared === null ||
      prepared.registrationGeneration !== session.registrationGeneration ||
      readManagedRuntimeStatus(machine, session).status !== 'live'
    )
      throw refusals.errors.UNAVAILABLE({ message: 'Native runtime catalog is unavailable' });
    return pageModelCatalog(
      prepared.models,
      input,
      {
        kind: 'session',
        ...(session.profile ? { profile: session.profile.name } : {}),
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
  const profile =
    input.profile === undefined ? undefined : selectAntigravityProfile(machine, input.profile);
  const profileId = antigravityProfileId(profile);
  const probed =
    freshHostCatalog(machine, Date.now(), profileId) ??
    (await probeAntigravityHostModels(machine, signal, profile));
  return pageModelCatalog(probed.models, input, {
    kind: 'host',
    ...(profile ? { profile: profile.name } : {}),
    machine: machine.rcPrefix,
    provider: 'antigravity',
    providerLabel: null,
    runtime: 'antigravity',
    observedAt: probed.observedAt,
    freshness: 'live',
  });
}
