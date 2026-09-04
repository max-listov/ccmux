import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMachine } from './helpers.ts';

/**
 * A name this machine does not have is never an answer of success.
 *
 * A typo in an address is the commonest mistake there is, and two verbs answered it with zero and a
 * true-sounding sentence: `stop` said "not running" and `logs` said "no live pane — nothing to
 * capture". Both are true of a session that exists and is stopped, and both are false of a name
 * that was never here — so a caller deciding by exit code was told the work was done. `restart`
 * already carried the fix and the comment explaining it; its neighbours did not.
 *
 * The table is the mechanism. A new session-addressed verb is one line here, and a verb that
 * decides to answer a miss with zero has to argue with this test rather than pass unnoticed.
 */

const root = mkdtempSync(join(tmpdir(), 'ccmux-unknown-session-'));
const configPath = join(root, 'machine.json');
writeFileSync(`${configPath}`, `${JSON.stringify(makeMachine({ stateDir: root }))}\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
env.CCMUX_CONFIG = configPath;
env.CCMUX_STATE_DIR = root;
env.CCMUX_CACHE_DIR = join(root, 'cache');

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const ABSENT = 'zzz-not-a-session';

/**
 * Every verb that takes a session name and acts on THAT session.
 *
 * `events` is deliberately absent: its `--session` is a filter over a log, and a query matching
 * nothing is an empty result rather than a miss. Verbs needing a live daemon or a real runtime
 * (`msg`, `chat`, `adopt`) are exercised where their own infrastructure exists.
 */
const VERBS: string[][] = [
  ['stop', ABSENT],
  ['start', ABSENT],
  ['restart', ABSENT],
  ['rm', ABSENT],
  ['renew', ABSENT],
  ['logs', ABSENT],
  ['transcript', ABSENT, '--last-message'],
  ['inbox', ABSENT],
  ['dir', ABSENT],
  ['role', ABSENT],
  ['mode', ABSENT, 'plan'],
  ['router', 'on', ABSENT],
  ['send', ABSENT, 'text'],
  ['wait', ABSENT, '--timeout', '1'],
];

test.each(VERBS)(
  'ccmux %s refuses a session this machine does not have',
  async (...argv) => {
    const proc = Bun.spawn(['bun', CLI, ...argv], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Non-zero, and the name is in what it said: a refusal that does not name the address it refused
    // sends the reader back to guessing which of their arguments was wrong.
    expect({ argv, code: code === 0 ? 0 : 1 }).toEqual({ argv, code: 1 });
    expect(`${out}${err}`).toContain(ABSENT);
  },
  30_000,
);
