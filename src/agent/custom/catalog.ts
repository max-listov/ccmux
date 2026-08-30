import { isAbsolute } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { resolveControlLaunchRecipe } from '../../config/launchRecipes.ts';
import { ControlModelCatalogSchema, type ControlModelsReadSchema } from '../../control/schema.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { prepareCustomHost } from './host.ts';

const CursorSchema = z
  .object({ digest: z.string().length(64), offset: z.int().min(0).max(128) })
  .strict();
/** Owner-authorized registry, not a vendor-wide model inventory; no inference process is started. */
export function readCustomModels(
  m: MachineConfig,
  input: z.output<typeof ControlModelsReadSchema>,
  target?: Session,
) {
  if (!target && !input.launchRecipe)
    throw new AppError('UNSUPPORTED', 'Choose a host launch recipe', 409);
  const launch = target ?? {
    ...resolveControlLaunchRecipe(m, m.stateDir, input.launchRecipe, [], 'custom'),
    dir: m.stateDir,
  };
  if (!target && launch.envFile !== undefined && !isAbsolute(launch.envFile))
    throw new AppError(
      'UNAVAILABLE',
      'Host catalog requires a host-scoped environment source',
      409,
    );
  const host = prepareCustomHost(m, launch);
  const digest = launch.launchRecipe?.digest;
  if (!digest) throw new Error('Custom catalog recipe is missing');
  let offset = 0;
  if (input.cursor !== null) {
    const parsed = CursorSchema.safeParse(
      JSON.parse(Buffer.from(input.cursor, 'base64url').toString()),
    );
    if (!parsed.success || parsed.data.digest !== digest)
      throw new AppError('CURSOR_MISMATCH', 'Model catalog identity changed', 409);
    offset = parsed.data.offset;
  }
  const rows = host.config.models.slice(offset, offset + input.limit);
  const next = offset + rows.length;
  return ControlModelCatalogSchema.parse({
    ...(input.target === undefined ? {} : { target: input.target }),
    source: {
      kind: target ? 'session' : 'host',
      machine: m.rcPrefix,
      provider: host.config.provider.kind,
      runtime: 'custom',
      launchRecipe: launch.launchRecipe,
    },
    data: rows.map(({ selection, capabilities }) => ({
      id: selection.model,
      model: selection.model,
      provider: selection.provider,
      displayName: selection.model,
      description: 'Host-authorized model',
      hidden: false,
      isDefault: selection.model === host.config.defaultModel.model,
      inputModalities: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
      serviceTiers: [],
    })),
    nextCursor:
      next < host.config.models.length
        ? Buffer.from(JSON.stringify({ digest, offset: next })).toString('base64url')
        : null,
  });
}
