import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The command Claude runs on every transcript event evaluates a leaf, not the product.
 *
 * Measured on the built bundle: 127 ms of CPU a call, of which 60 ms is parsing the bundle and the
 * rest was evaluating the module graph this command reached for six numbers — `zod` costs about as
 * much to evaluate as everything else the command does, and `sessionStatus.ts` pulls the agent
 * barrel, chat types and launch stamps behind it. At 29 renders a minute across seven sessions that
 * graph was costing about 2 % of a core to write a file.
 *
 * Checked on the source rather than by the clock, for the same reason the lazy-dispatch case is: a
 * wall-clock assertion on a loaded machine fails for reasons that have nothing to do with what it
 * guards. The property is exact — an import added here the obvious way brings its whole graph back,
 * and nothing about that diff would look wrong.
 */

const source = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'statusLine.ts'),
  'utf8',
);
const leaf = readFileSync(join(import.meta.dir, '..', 'src', 'agent', 'metricsFile.ts'), 'utf8');

const imports = (text: string): string[] =>
  [...text.matchAll(/^import[^']*'([^']+)';$/gm)].map((match) => match[1] as string);

test('the status-line command imports no schema library and no agent graph', () => {
  const specifiers = imports(source);
  expect(specifiers).not.toContain('zod');
  expect(specifiers).not.toContain('../agent/sessionStatus.ts');
  // What it may reach for: node built-ins and the metrics leaf. Anything else is a new graph on the
  // hottest path this tool has, and belongs behind a deliberate measurement.
  for (const specifier of specifiers)
    expect(specifier.startsWith('node:') || specifier === '../agent/metricsFile.ts').toBe(true);
});

test('the metrics leaf stays a leaf', () => {
  const specifiers = imports(leaf);
  expect(specifiers).not.toContain('zod');
  for (const specifier of specifiers)
    expect(
      specifier.startsWith('node:') ||
        specifier === '../config/paths.ts' ||
        specifier === '../util/atomic.ts',
    ).toBe(true);
});

test('one implementation of the metrics file, re-exported rather than copied', () => {
  const status = readFileSync(
    join(import.meta.dir, '..', 'src', 'agent', 'sessionStatus.ts'),
    'utf8',
  );
  // The heavy module keeps the names its callers use, and gets them from the leaf: a second reader
  // or writer of this file would be a second authority on its format, which is how a field arrives
  // in one place and vanishes in another.
  expect(status).toContain('readMetricsFile as readMetrics');
  expect(status).not.toContain('MetricsStatusSchema');
});
