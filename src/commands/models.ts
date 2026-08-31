import { prepareCustomHost } from '../agent/custom/host.ts';
import { registrySettled, verdictLines, verifyCustomRegistry } from '../agent/custom/verify.ts';
import { resolveControlLaunchRecipe } from '../config/launchRecipes.ts';
import { loadMachineConfig } from '../config/machine.ts';

/**
 * Check a host's declared model registry against the provider that must serve it.
 *
 * Host-initiated by design. Nothing calls this before a turn and nothing depends on it at startup,
 * because a diagnostic that becomes a dependency turns an unreachable model server into a broken
 * runtime — which is exactly the trade this check exists to avoid making.
 */
export async function cmdModels(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const recipeId = positional[0];
  if (!recipeId || args.some((arg) => arg.startsWith('--') && arg !== '--json')) {
    console.error('usage: ccmux models <launch-recipe-id> [--json]');
    return 1;
  }
  const m = loadMachineConfig();
  const recipe = m.launchRecipes[recipeId];
  if (!recipe?.custom) {
    console.error(`models: no custom launch recipe '${recipeId}' on this machine`);
    return 1;
  }
  let host: ReturnType<typeof prepareCustomHost>;
  try {
    const launch = resolveControlLaunchRecipe(
      m,
      m.stateDir,
      { id: recipeId, revision: recipe.revision },
      [],
      'custom',
    );
    host = prepareCustomHost(m, { ...launch, dir: m.stateDir });
  } catch (error) {
    console.error(`models: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const verdict = await verifyCustomRegistry(host.config, host.credential);
  if (json) console.log(JSON.stringify(verdict));
  else for (const line of verdictLines(verdict)) console.log(line);
  // Three outcomes, three codes: the declaration holds, the provider contradicted it, or we could
  // not look. Collapsing the last two would report a quiet server as a broken registry.
  if (registrySettled(verdict)) return 0;
  return verdict.probe === 'reached' ? 2 : 3;
}
