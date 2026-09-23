import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * `src/commands/` reads command lines and prints answers; nothing else depends on it.
 *
 * The daemon had imported self-update from the `update` command, the control plane mail-hold logic
 * from `wait`, the TUI the session rows from `list` — so a change to how a command prints could reach
 * the daemon, and a reader looking for where sessions are healed found it filed under a CLI verb.
 * The domain now lives in `session/`, `release/`, `inventory/`, `chat/` and `context/`; this keeps it
 * there.
 */
test('only the CLI entry and the commands themselves import from src/commands', () => {
  const src = join(import.meta.dir, '..', 'src');
  const commands = join(src, 'commands');
  const offenders: string[] = [];
  for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync(src)) {
    const path = join(src, file);
    if (path.startsWith(`${commands}/`) || file === 'cli.ts') continue;
    for (const [, spec] of readFileSync(path, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const target = resolve(dirname(path), spec as string);
      if (target.startsWith(`${commands}/`)) offenders.push(`${file} → ${relative(src, target)}`);
    }
  }
  expect(offenders).toEqual([]);
});
