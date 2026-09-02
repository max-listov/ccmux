import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The dispatch loads the command it is about to run, and nothing else.
 *
 * The bundle is one file and is parsed whole either way; a static import at the entry adds
 * EVALUATION of the whole product before the verb is read. That is paid on the hottest paths this
 * tool has — the two Claude hooks, which run on every turn, and the statusLine tee, which runs on
 * every transcript event, per session. Measured through the shipped bundle: 208 ms of CPU for a
 * status-line render that does about a millisecond of work, against 43 ms for the same work with
 * nothing else evaluated. Seventeen sessions on one machine make that a constant background load.
 *
 * Checked on the source rather than by the clock, because a wall-clock assertion on a loaded
 * machine fails for reasons that have nothing to do with what it guards. The property is exact: a
 * new command added the obvious way — an import at the top, a case below — reintroduces the cost
 * for every other command, and nothing about the diff would look wrong.
 */
const ENTRY = readFileSync(resolve('src/cli.ts'), 'utf8');

// Help and the retired-token notice are the exceptions ON PURPOSE: both run BEFORE the switch, for
// every invocation, so deferring them would buy nothing and cost a branch. Both are leaf modules.
const EAGER_BY_DESIGN = new Set([
  './commands/help.ts',
  './commands/retired.ts',
  './util/version.ts',
]);

test('the CLI entry imports no command module eagerly', () => {
  const eager = [...ENTRY.matchAll(/^import .* from '([^']+)';$/gm)]
    .map((match) => match[1] as string)
    .filter((specifier) => !EAGER_BY_DESIGN.has(specifier));
  expect(eager).toEqual([]);
});

test('every dispatched command is reached through a dynamic import', () => {
  // The negative half: a case that calls a bare `cmdX(` is one that got its module eagerly. Any
  // name matching `cmd*` must be reached through `(await import(...)).cmdX(`.
  const calls = [...ENTRY.matchAll(/(\(await import\('[^']+'\)\)\.)?\b(cmd[A-Z]\w*)\(/g)];
  expect(calls.length).toBeGreaterThan(30);
  const eagerCalls = calls
    .filter((match) => match[1] === undefined && match[2] !== 'cmdHelp')
    .map((match) => match[2] as string);
  expect(eagerCalls).toEqual([]);
});
