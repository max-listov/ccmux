import { AppError } from 'stitchkit';
import { z } from 'zod';
import { nativeModelProvider, withCodexCatalogRuntime } from '../agent/codex/catalogRuntime.ts';
import { modelSelectionLabel } from '../runtime/selectionSchema.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import type { ResolvedControlLaunch } from './launchRecipes.ts';
import type { ModelSelection } from './modelSelectionFlags.ts';

/** The caller selects a model, never a provider endpoint or authentication configuration. */
export async function validateModelSelection(
  m: MachineConfig,
  launch: ResolvedControlLaunch,
  workspace: string,
  selection: ModelSelection,
  signal: AbortSignal,
): Promise<void> {
  try {
    await withCodexCatalogRuntime(m, launch, workspace, signal, async (rpc) => {
      const provider = await nativeModelProvider(rpc, workspace);
      if (provider !== selection.provider)
        throw new Error('Selected provider differs from host launch configuration');
      // Custom providers own their model identifiers; native thread admission verifies them.
      // The OpenAI catalog is provider-owned and can validate the selection before any writer.
      if (provider !== 'openai') return;
      let cursor: string | null = null;
      for (let page = 0; page < 8; page++) {
        const result = z
          .object({
            data: z.array(z.object({ id: z.string(), model: z.string().optional() })).max(64),
            nextCursor: z.string().nullable(),
          })
          .parse(
            await rpc.request('model/list', {
              limit: 64,
              includeHidden: true,
              ...(cursor === null ? {} : { cursor }),
            }),
          );
        if (result.data.some((model) => (model.model ?? model.id) === selection.model)) return;
        if (result.nextCursor === null || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
      throw new Error('Selected model is absent from the authenticated catalog');
    });
  } catch (error) {
    log.error({ msg: 'managed model selection refused', selection, reason: String(error) });
    // The key is the caller's own input and the catalog publishes it, so naming it discloses
    // nothing; the reason stays owner-side because it can name host launch configuration.
    throw new AppError(
      'MODEL_UNAVAILABLE',
      `Model ${modelSelectionLabel(selection)} is unavailable`,
      409,
    );
  }
}
