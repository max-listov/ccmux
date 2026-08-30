import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { AppError } from 'stitchkit';
import { ownedCodexFlags } from '../agent/codex/ownedLaunch.ts';
import { envFilePath, stableJson } from '../agent/launchInputs.ts';
import { isReservedEnvKey, sessionEnvRecipe } from '../agent/sessionEnv.ts';
import type {
  LaunchRecipeMetadata,
  LaunchRecipeReference,
  MachineConfig,
  MachineLaunchRecipe,
  Session,
} from '../types.ts';
import { log } from '../util/log.ts';
import { modelSelectionFlags } from './modelSelectionFlags.ts';
import { MachineLaunchRecipeSchema } from './schema.ts';

const MAX_RECIPE_ENV_FILE_BYTES = 1024 * 1024;

export type ResolvedControlLaunch = {
  flags: string[];
  envFile?: string;
  launchRecipe?: LaunchRecipeMetadata;
};

function recipeDigest(recipe: MachineLaunchRecipe): string {
  const canonical = {
    revision: recipe.revision,
    ...(recipe.envFile === undefined ? {} : { envFile: recipe.envFile }),
    flags: recipe.flags,
    environment: [...new Set(recipe.environment)].sort(),
    capabilities: [...new Set(recipe.capabilities)].sort(),
    ...(recipe.collaborationMode === undefined
      ? {}
      : { collaborationMode: recipe.collaborationMode }),
    ...(recipe.custom === undefined ? {} : { custom: recipe.custom }),
  };
  return createHash('sha256').update(stableJson(canonical)).digest('hex');
}

function unavailable(id: string, reason: string): never {
  log.error({ msg: 'configured launch recipe is unavailable', recipeId: id, reason });
  throw new AppError('LAUNCH_RECIPE_UNAVAILABLE', 'Launch recipe is unavailable', 409);
}

function verifyAvailability(
  m: MachineConfig,
  workspace: string,
  id: string,
  recipe: MachineLaunchRecipe,
): void {
  try {
    if (recipe.custom === undefined) ownedCodexFlags([...recipe.flags, ...m.extraFlags]);
    else if (recipe.flags.length > 0 || recipe.collaborationMode !== undefined)
      unavailable(id, 'custom composition cannot carry Codex configuration');
  } catch (error) {
    unavailable(id, `native configuration was refused: ${String(error)}`);
  }
  for (const name of [
    ...recipe.environment,
    ...(recipe.custom === undefined
      ? []
      : [
          recipe.custom.provider.credentialEnv,
          recipe.custom.approvalSecretEnv,
          ...recipe.custom.commandEnvironment,
        ]),
  ]) {
    if (isReservedEnvKey(name)) unavailable(id, `environment name ${name} is reserved`);
  }
  if (recipe.envFile !== undefined) {
    const path = envFilePath({ dir: workspace, envFile: recipe.envFile });
    if (path === null) unavailable(id, 'declared environment file did not resolve');
    try {
      const stat = statSync(path);
      if (!stat.isFile()) unavailable(id, 'declared environment source is not a regular file');
      if (stat.size > MAX_RECIPE_ENV_FILE_BYTES)
        unavailable(id, 'declared environment source exceeds its size limit');
      accessSync(path, constants.R_OK);
    } catch (error) {
      if (error instanceof AppError) throw error;
      unavailable(id, `declared environment source is unreadable: ${String(error)}`);
    }
  }
  const environment = sessionEnvRecipe(
    { dir: workspace, ...(recipe.envFile === undefined ? {} : { envFile: recipe.envFile }) },
    process.env,
    process.env.NODE_ENV,
  );
  if (environment.refused.length > 0)
    unavailable(
      id,
      `declared environment tried to set reserved names: ${environment.refused.join(',')}`,
    );
  const required =
    recipe.custom === undefined
      ? recipe.environment
      : [
          ...recipe.environment,
          recipe.custom.provider.credentialEnv,
          recipe.custom.approvalSecretEnv,
        ];
  const missing = [...new Set(required)]
    .filter((name) => environment.env[name] === undefined)
    .sort();
  if (missing.length > 0)
    unavailable(id, `required environment names are unavailable: ${missing.join(',')}`);
}

/** Resolve before create receipts, registry mutation or provider spawn. The caller controls only an
 * immutable name+revision reference; every launch-affecting value comes from machine config. */
export function resolveControlLaunchRecipe(
  m: MachineConfig,
  workspace: string,
  reference: LaunchRecipeReference | undefined,
  callerFlags: readonly string[],
  runtime: 'codex' | 'custom' = 'codex',
): ResolvedControlLaunch {
  if (reference === undefined) return { flags: [...callerFlags] };
  if (callerFlags.length > 0)
    throw new AppError('INVALID_RECIPE_CREATE', 'Launch recipe owns native configuration', 409);
  const configured = m.launchRecipes[reference.id];
  if (configured === undefined) unavailable(reference.id, 'recipe id is not configured');
  const parsed = MachineLaunchRecipeSchema.safeParse(configured);
  if (!parsed.success) unavailable(reference.id, 'host recipe definition is invalid');
  const recipe = parsed.data;
  if ((recipe.custom === undefined ? 'codex' : 'custom') !== runtime)
    unavailable(reference.id, 'recipe runtime differs from requested runtime');
  if (recipe.revision !== reference.revision)
    unavailable(reference.id, `requested revision ${reference.revision} is not active`);
  verifyAvailability(m, workspace, reference.id, recipe);
  const launchRecipe: LaunchRecipeMetadata = {
    id: reference.id,
    revision: recipe.revision,
    digest: recipeDigest(recipe),
    capabilities: [...new Set(recipe.capabilities)].sort(),
    ...(recipe.collaborationMode === undefined
      ? {}
      : { collaborationMode: recipe.collaborationMode }),
  };
  return {
    flags: [...recipe.flags],
    ...(recipe.envFile === undefined ? {} : { envFile: recipe.envFile }),
    launchRecipe,
  };
}

/** Every managed App Server spawn revalidates the immutable host definition. A removed or edited
 * recipe blocks before Bun.spawn, while an unchanged recipe keeps the persisted UUID/generation. */
export function verifyManagedLaunchRecipe(
  m: MachineConfig,
  session: Pick<Session, 'dir' | 'envFile' | 'flags' | 'launchRecipe' | 'modelSelection'> & {
    agent?: Session['agent'];
  },
): void {
  if (session.launchRecipe === undefined) return;
  const resolved = resolveControlLaunchRecipe(
    m,
    session.dir,
    { id: session.launchRecipe.id, revision: session.launchRecipe.revision },
    [],
    session.agent === 'custom' ? 'custom' : 'codex',
  );
  if (
    resolved.launchRecipe?.digest !== session.launchRecipe.digest ||
    stableJson(resolved.launchRecipe?.capabilities ?? []) !==
      stableJson(session.launchRecipe.capabilities) ||
    stableJson([
      ...resolved.flags,
      ...(session.agent === 'custom' ? [] : modelSelectionFlags(session.modelSelection)),
    ]) !== stableJson(session.flags) ||
    resolved.envFile !== session.envFile
  )
    unavailable(
      session.launchRecipe.id,
      'persisted managed launch no longer matches its configured recipe',
    );
}
