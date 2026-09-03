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

/**
 * A command a person can type is a command `ccmux help` names.
 *
 * `models` and `router` both existed, dispatched and worked, and appeared in neither the help list
 * nor the shell completions that are generated from it — one of them referenced by name in an
 * architecture document, which is how it was found at all. Nothing pointed at the omission,
 * because nothing compares the two lists; a new verb is a case in one file and an entry in
 * another, and only the first is needed to make it run.
 *
 * The exceptions are stated rather than derived: an alias is documented under its canonical verb, a
 * flag is not a verb, and the four entry points below are invoked by the supervisor and the harness
 * rather than typed by anyone. Adding a verb now forces that choice instead of leaving it to be
 * noticed later.
 */
test('every verb a person can type is in the help list', async () => {
  const { COMMANDS } = await import('../src/commands/help.ts');
  const documented = new Set(COMMANDS.map((entry) => entry.verb));
  const ALIASES = new Map([
    ['ls', 'list'],
    ['l', 'list'],
    ['remove', 'rm'],
  ]);
  const INTERNAL = new Set(['daemon', 'stop-hook', 'hook-status', 'status-line']);
  const cases = [...ENTRY.matchAll(/case '([a-z0-9:-]+)':/g)].map((match) => match[1] as string);
  expect(cases.length).toBeGreaterThan(30);
  const missing = cases.filter(
    (verb) =>
      !documented.has(verb) && !INTERNAL.has(verb) && !ALIASES.has(verb) && !verb.startsWith('-'),
  );
  expect(missing).toEqual([]);
  // An alias is only exempt while the verb it stands for is documented.
  expect([...ALIASES.values()].filter((verb) => !documented.has(verb))).toEqual([]);
  // And the list does not name commands that do not exist: `ccmux help` is read as an inventory.
  expect(COMMANDS.map((entry) => entry.verb).filter((verb) => !cases.includes(verb))).toEqual([]);
});
