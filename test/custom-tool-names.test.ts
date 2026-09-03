import { expect, test } from 'bun:test';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { CustomToolNameSchema } from '../src/agent/custom/config.ts';

/**
 * One set of tool names, written down twice: the enum a recipe declares from, and what the harness
 * composes. They disagreed in both directions at once — `apply_patch` could be declared and was
 * never built, `edit_file`/`glob`/`list_directory` were built and could not be declared — and the
 * disagreement surfaced as two dead sessions at a consumer rather than as a red test here.
 */

const built = (executables: Record<string, string>) =>
  createAgentCodingTools({
    root: process.cwd(),
    authorize: () => true,
    executables,
    environment: {},
    artifacts: { write: async () => ({ id: 'probe' }) } as never,
    limits: { maxArtifactBytes: 1024, maxShellOutputBytes: 1024, maxReadBytes: 1024 },
  })
    .map((tool) => tool.name)
    .sort();

test('every declarable tool name is one the harness composes, and every composed one is declarable', () => {
  // Measured against a config that supplies everything, so the comparison is about the NAMES and
  // not about what this particular recipe happens to enable.
  const harness = built({ probe: '/bin/ls' });
  // `read_resource` comes from the recipe's resources, not from the coding tools, so it is the one
  // declarable name this comparison adds by hand — and it is added on the harness side, where it
  // is composed, rather than excused on the schema side.
  const composed = [...harness, 'read_resource'].sort();
  const declarable: string[] = [...CustomToolNameSchema.options];
  expect(declarable.sort()).toEqual(composed);
});

test('the two config-dependent names are the ones the recipe check treats as config-dependent', () => {
  // The recipe refuses `run_command` without an executable and `read_resource` without a resource.
  // That rule is a hand-written statement about the harness, so it is pinned against the harness:
  // if a future version composes run_command unconditionally, this reddens and the rule is wrong.
  expect(built({})).not.toContain('run_command');
  expect(built({ probe: '/bin/ls' })).toContain('run_command');
  // Nothing else in the set moves with that config; a name appearing or vanishing here means the
  // recipe check is judging the wrong ones.
  expect(built({ probe: '/bin/ls' }).filter((name) => name !== 'run_command')).toEqual(built({}));
});
