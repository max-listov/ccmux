import { expect, test } from 'bun:test';
import { COMMANDS } from '../src/commands/help.ts';

/**
 * What help says a command accepts is exactly what the command accepts.
 *
 * They drifted when each command read its own arguments: flags parsed and never documented
 * (`list --json`, `chat log --follow`, `install --force`…), and a documented form nothing read. The
 * parser now reads each command's `flags` spec and nothing else, so the remaining drift is between
 * that spec and the help text — which is what this compares, both ways.
 */
// Not read through the spec: `control` is the typed service CLI with its own generated parser,
// `send` passes keys through verbatim (any key may look like a flag), and `tui`'s `-f` is dispatched
// before any command runs.
const RAW = new Set(['control', 'send', 'tui']);

const mentioned = (args: string): Set<string> =>
  new Set(
    [...args.matchAll(/(?<![\w-])(--[a-z][a-z-]*|-[A-Za-z])(?![\w-])/g)].map((m) => m[1] as string),
  );

test('every documented flag is read, and every read flag is documented', () => {
  const drift: string[] = [];
  for (const command of COMMANDS) {
    if (RAW.has(command.verb)) continue;
    const documented = mentioned(command.args);
    documented.delete('--help'); // answered for every verb before its command runs
    const read = new Set(
      (command.flags ?? []).flatMap((flag) =>
        flag.name.length === 1
          ? [`-${flag.name}`]
          : [`--${flag.name}`, ...(flag.short === undefined ? [] : [`-${flag.short}`])],
      ),
    );
    for (const flag of documented)
      if (!read.has(flag)) drift.push(`${command.verb}: help mentions ${flag}, nothing reads it`);
    for (const flag of read)
      if (!documented.has(flag))
        drift.push(`${command.verb}: reads ${flag}, help never mentions it`);
  }
  expect(drift).toEqual([]);
});
