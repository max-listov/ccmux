import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { prepareCustomHost } from '../src/agent/custom/host.ts';
import { stableJson } from '../src/agent/launchInputs.ts';
import { verifyManagedLaunchRecipe } from '../src/config/launchRecipes.ts';
import { customFixture } from './custom-fixture.ts';

test('pre-service recipes resume unchanged, but actual capability changes still fail closed', async () => {
  const { m, s } = await customFixture();
  const recipe = m.launchRecipes.coding;
  if (!recipe?.custom || !s.launchRecipe) throw new Error('fixture missing');
  const { services: _, ...custom } = recipe.custom;
  // The persisted representation before services existed, independent of today's resolver.
  const digest = createHash('sha256')
    .update(
      stableJson({
        revision: recipe.revision,
        envFile: recipe.envFile,
        flags: [],
        environment: [],
        capabilities: [],
        custom,
      }),
    )
    .digest('hex');
  expect(digest).not.toBe(s.launchRecipe.digest);
  s.launchRecipe.digest = digest;
  expect(() => verifyManagedLaunchRecipe(m, s)).not.toThrow();
  expect(prepareCustomHost(m, s).config.services).toEqual([]);

  recipe.custom.tools.push('read_file');
  expect(() => verifyManagedLaunchRecipe(m, s)).toThrow('Launch recipe is unavailable');
  expect(() => prepareCustomHost(m, s)).toThrow('Launch recipe is unavailable');
  recipe.custom.tools.pop();
  recipe.custom.services.push({ id: 'service', command: '/bin/echo', args: [], tools: ['read'] });
  expect(() => verifyManagedLaunchRecipe(m, s)).toThrow('Launch recipe is unavailable');
  expect(() => prepareCustomHost(m, s)).toThrow('Launch recipe is unavailable');
});
