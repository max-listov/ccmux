import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { AppError } from 'stitchkit';
import { resolveControlLaunchRecipe } from '../../config/launchRecipes.ts';
import { MAX_POLICY_BYTES, readPolicySource } from '../../policy/sources.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { stableJson } from '../launchInputs.ts';
import { isReservedEnvKey, sessionEnvRecipe } from '../sessionEnv.ts';
import type { CustomLaunchConfig } from './config.ts';

export function prepareCustomHost(
  m: MachineConfig,
  session: Pick<Session, 'dir' | 'envFile' | 'flags' | 'launchRecipe'>,
) {
  const accepted = session.launchRecipe;
  if (!accepted)
    throw new AppError('UNAVAILABLE', 'Custom runtime requires a host launch recipe', 409);
  const launch = resolveControlLaunchRecipe(m, session.dir, accepted, [], 'custom');
  if (
    stableJson(launch.launchRecipe) !== stableJson(accepted) ||
    launch.envFile !== session.envFile ||
    session.flags.length !== 0
  )
    throw new AppError('LAUNCH_RECIPE_UNAVAILABLE', 'Launch recipe is unavailable', 409);
  const config = m.launchRecipes[accepted.id]?.custom;
  if (!config) throw new AppError('UNAVAILABLE', 'Custom runtime is unavailable', 409);
  const environment = sessionEnvRecipe(session, process.env, process.env.NODE_ENV);
  const names = [
    config.provider.credentialEnv,
    config.approvalSecretEnv,
    ...config.commandEnvironment,
  ];
  if (environment.refused.length || names.some(isReservedEnvKey))
    throw new Error('Custom environment contains reserved capabilities');
  const credential = environment.env[config.provider.credentialEnv];
  const approvalSecret = environment.env[config.approvalSecretEnv];
  if (!credential || !approvalSecret || Buffer.byteLength(approvalSecret) < 32)
    throw new Error('Custom execution credentials are unavailable or invalid');
  const commandEnvironment: Record<string, string> = {};
  for (const name of config.commandEnvironment) {
    const value = environment.env[name];
    if (value === undefined) throw new Error('Custom command environment is unavailable');
    commandEnvironment[name] = value;
  }
  for (const executable of Object.values(config.executables)) {
    if (!statSync(executable).isFile() || realpathSync(executable) !== executable)
      throw new Error('Custom executable is not a canonical regular file');
    accessSync(executable, constants.X_OK);
  }
  let bytes = 0;
  const resources = config.resources.map((source) => {
    const body = readPolicySource(accepted.id, config.trustedRoots, source);
    bytes += Buffer.byteLength(body);
    if (bytes > MAX_POLICY_BYTES) throw new Error('Custom resources exceed the composition budget');
    return { ...source, body };
  });
  return { config, credential, approvalSecret, commandEnvironment, resources };
}
export type PreparedCustomHost = ReturnType<typeof prepareCustomHost>;

export function customModel(config: CustomLaunchConfig, selection: Session['modelSelection']) {
  const selected = selection ?? config.defaultModel;
  const model = config.models.find(
    ({ selection: candidate }) =>
      candidate.provider === selected.provider && candidate.model === selected.model,
  );
  if (!model) throw new AppError('UNSUPPORTED', 'Requested model is unavailable', 409);
  return model;
}
