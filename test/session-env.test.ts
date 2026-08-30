import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envFilePath } from '../src/agent/launchInputs.ts';
import type { LaunchStamp } from '../src/agent/launchStamp.ts';
import {
  inheritsUndeclaredEnv,
  isReservedEnvKey,
  parseEnvFile,
  sessionEnvRecipe,
} from '../src/agent/sessionEnv.ts';
import { withNoEnvFile } from '../src/env.ts';

// What this replaces, measured on a live fleet: 5 of 14 sessions were handed their project's `.env`
// — API keys among them — because the supervisor is a Bun process whose cwd is the session directory,
// the runtime loads that directory's `.env` into itself, and the launcher copied its whole
// environment into the agent and thus into every process the agent spawns. Nobody declared any of it.

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccmux-env-'));
  mkdirSync(join(dir, 'proj'), { recursive: true });
  writeFileSync(join(dir, 'proj', '.env'), 'PROJECT_SECRET=leak-me\nSHARED=from-dotenv\n');
  writeFileSync(join(dir, 'proj', 'declared.env'), 'export TOKEN="tok"\nURL=https://x/$TOKEN\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const proj = () => join(dir, 'proj');
const inherited = {
  PATH: '/usr/bin',
  PROJECT_SECRET: 'leak-me',
  SHARED: 'from-dotenv',
  REAL: 'kept',
};

// ── parsing: ccmux owns the recipe, not whichever runtime hosts it ───────────────────────────────

test('quotes, comments, export, expansion and multi-line values', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      'export A=plain',
      'B="double"',
      "C='raw $A'", // single quotes never expand, as in every shell
      'D="pre-$A"',
      'E="line1',
      'line2"',
      'bad line',
    ].join('\n'),
  );
  expect(parsed).toEqual({
    A: 'plain',
    B: 'double',
    C: 'raw $A',
    D: 'pre-plain',
    E: 'line1\nline2',
  });
});

test('expansion also sees the environment being built, not only the file', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal dotenv expansion is the input under test.
  expect(parseEnvFile('X=${BASE}/bin', { BASE: '/opt' })).toEqual({ X: '/opt/bin' });
  // An undefined reference expands to empty rather than to the literal — matching every dotenv loader
  // and, more importantly, never leaving a half-substituted string that looks like a real value.
  expect(parseEnvFile('X=$NOPE/bin')).toEqual({ X: '/bin' });
});

// ── the recipe ───────────────────────────────────────────────────────────────────────────────────

test('an undeclared directory .env no longer reaches the agent', () => {
  const { env, removed } = sessionEnvRecipe({ dir: proj() }, inherited, undefined);
  expect(env.PROJECT_SECRET).toBeUndefined();
  expect(env.SHARED).toBeUndefined();
  expect(removed).toEqual(['PROJECT_SECRET', 'SHARED']);
  // Everything that did NOT come from that file is untouched: this removes a leak, not an environment.
  expect(env.REAL).toBe('kept');
  expect(env.PATH).toBe('/usr/bin');
});

test('a declared file is applied, and wins', () => {
  const { env } = sessionEnvRecipe({ dir: proj(), envFile: 'declared.env' }, inherited, undefined);
  expect(env.TOKEN).toBe('tok');
  expect(env.URL).toBe('https://x/tok');
  // …and declaring one file does not smuggle the OTHER one back in.
  expect(env.PROJECT_SECRET).toBeUndefined();
});

test("declaring the directory's own .env is how you keep it — deliberately, by name", () => {
  const { env, removed } = sessionEnvRecipe({ dir: proj(), envFile: '.env' }, inherited, undefined);
  expect(env.PROJECT_SECRET).toBe('leak-me');
  expect(removed).toEqual([]);
});

test('a project file cannot reconfigure its own supervisor', () => {
  // Without this, an .env in a working directory could set CCMUX_STATE_DIR and repoint the whole
  // instance, or set CCMUX_SESSION and make one session answer to another's name — from a file that
  // is often not even in version control.
  writeFileSync(
    join(dir, 'proj', 'hijack.env'),
    'CCMUX_STATE_DIR=/tmp/hijacked\nCCMUX_SESSION=other\nOK=1\n',
  );
  const { env, refused } = sessionEnvRecipe(
    { dir: proj(), envFile: 'hijack.env' },
    inherited,
    undefined,
  );
  expect(refused).toEqual(['CCMUX_SESSION', 'CCMUX_STATE_DIR']);
  expect(env.CCMUX_STATE_DIR).toBeUndefined();
  expect(env.OK).toBe('1'); // the rest of the file still applies — refusal is per name, not per file
  expect(isReservedEnvKey('CCMUX_ANYTHING')).toBe(true);
});

test('a declared file that is missing costs a variable, never the session', () => {
  // A supervisor whose sessions refuse to boot is worse than a session one variable short: self-heal
  // would otherwise beat itself against a vanished file forever.
  const { env } = sessionEnvRecipe({ dir: proj(), envFile: 'not-here.env' }, inherited, undefined);
  expect(env.REAL).toBe('kept');
});

test('relative paths resolve against the session dir, absolute pass through', () => {
  expect(envFilePath({ dir: '/p', envFile: '.env' })).toBe('/p/.env');
  expect(envFilePath({ dir: '/p', envFile: '/etc/x.env' })).toBe('/etc/x.env');
  expect(envFilePath({ dir: '/p' })).toBeNull();
});

// ── who still needs migrating ────────────────────────────────────────────────────────────────────

const stamp = (inputs: LaunchStamp['inputs']): LaunchStamp => ({
  version: '0',
  hash: 'h',
  permissionMode: 'auto',
  chatEnabled: true,
  promptModules: [],
  envKeys: [],
  inputs,
  ts: 0,
});

test('a session launched BEFORE the recipe existed is on the migration list', () => {
  // The case the first version of this check missed, which made the list read empty on the very fleet
  // that needed it: those stamps have no `inputs` map at all, and that absence is the proof they were
  // launched by a build that still inherited.
  expect(inheritsUndeclaredEnv({ dir: proj(), archived: false }, stamp(null), undefined)).toBe(
    true,
  );
});

test('a session launched UNDER the recipe with nothing declared is not — the file beside it is inert', () => {
  expect(
    inheritsUndeclaredEnv({ dir: proj(), archived: false }, stamp({ env: null }), undefined),
  ).toBe(false);
});

test('a stamp that digested a directory file is still carrying it', () => {
  expect(
    inheritsUndeclaredEnv({ dir: proj(), archived: false }, stamp({ env: 'd1' }), undefined),
  ).toBe(true);
});

test('declared, archived, or unknown are never on the list', () => {
  expect(
    inheritsUndeclaredEnv(
      { dir: proj(), archived: false, envFile: '.env' },
      stamp(null),
      undefined,
    ),
  ).toBe(false);
  expect(inheritsUndeclaredEnv({ dir: proj(), archived: true }, stamp(null), undefined)).toBe(
    false,
  );
  expect(inheritsUndeclaredEnv({ dir: proj(), archived: false }, null, undefined)).toBe(false);
  // No file in the directory → nothing to inherit, whatever the stamp says.
  expect(inheritsUndeclaredEnv({ dir, archived: false }, stamp(null), undefined)).toBe(false);
});

// ── the other half of the guarantee: the runtime never loads those files in the first place ──────

test('the pane re-exec tells the runtime not to load .env from wherever it lands', () => {
  expect(withNoEnvFile(['/bin/bun', '/opt/ccmux.js'])).toEqual([
    '/bin/bun',
    '--no-env-file',
    '/opt/ccmux.js',
  ]);
});

test('a compiled single-file build is left alone — the flag would be a lie there', () => {
  // Probed against Bun 1.3.14: a `bun build --compile` binary passes the flag through to the app's
  // argv and still loads `.env`, and no environment variable or bunfig substitutes for it. Adding it
  // would read as a guarantee that is not there; the recipe's subtraction is what covers that shape.
  expect(withNoEnvFile(['/opt/ccmux'])).toEqual(['/opt/ccmux']);
});
