import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envFileKeys,
  envFiles,
  envInput,
  fileDigest,
  fileSetDigest,
  inheritedEnvInput,
  jsonFieldDigest,
  ruleSetFiles,
  stableJson,
  tomlTableDigest,
} from '../src/agent/launchInputs.ts';
import { type LaunchStamp, staleReasons } from '../src/agent/launchStamp.ts';

// The blind spot these cover, measured: a global rule set changed, every session on the fleet was
// running yesterday's rules, and RESTART was blank for all of them. The only remedy left was bouncing
// two dozen sessions on three machines without knowing which had actually fallen behind.

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccmux-inputs-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text: string): string => {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};

// ── a rule set is a file PLUS what it pulls in ───────────────────────────────────────────────────

test('a rule set expands its imports, machine-specific ones included', () => {
  const entry = write('rules/GLOBAL.md', 'base rules\n@./machine.md\n@../shared/team.md\n');
  write('rules/machine.md', 'this machine only');
  write('shared/team.md', 'team rules');
  const files = ruleSetFiles(entry);
  expect(files).toContain(entry);
  expect(files.some((f) => f.endsWith('/machine.md'))).toBe(true);
  expect(files.some((f) => f.endsWith('/team.md'))).toBe(true);
});

test('an import cycle terminates instead of hanging the supervisor', () => {
  const a = write('cycle/a.md', '@./b.md');
  write('cycle/b.md', '@./a.md');
  const files = ruleSetFiles(a);
  expect(files.length).toBe(2);
  expect(new Set(files).size).toBe(2);
});

test('a package name or an email is not an import — chasing it would add noise and stat calls', () => {
  const entry = write(
    'pkg/GLOBAL.md',
    'use @anthropic-ai/sdk, ask someone@example.com\n@./real.md\n',
  );
  write('pkg/real.md', 'x');
  const files = ruleSetFiles(entry);
  expect(files.length).toBe(2);
  expect(files.some((f) => f.includes('anthropic-ai'))).toBe(false);
});

test("a missing import still counts — 'the import is absent here' is a real difference between machines", () => {
  const entry = write('missing/GLOBAL.md', '@./gone.md\n');
  expect(ruleSetFiles(entry).some((f) => f.endsWith('/gone.md'))).toBe(true);
});

test('editing an IMPORTED file moves the set digest — the entry file alone would have missed it', () => {
  const entry = write('edit/GLOBAL.md', '@./child.md\n');
  write('edit/child.md', 'v1');
  const before = fileSetDigest(ruleSetFiles(entry));
  write('edit/child.md', 'v2 — the owner changed a rule');
  const after = fileSetDigest(ruleSetFiles(entry));
  expect(before).not.toBe(after);
});

test("a set that exists nowhere digests as null — absent is stable, not 'changed every tick'", () => {
  expect(fileSetDigest([join(dir, 'nothing-here.md')])).toBeNull();
  expect(fileDigest(join(dir, 'nothing-here.md'))).toBeNull();
});

// ── hashing a FIELD, not the file around it ──────────────────────────────────────────────────────

test('an MCP table digest ignores everything else in the file it lives in', () => {
  // This is the whole reason the digest is field-scoped. The agent rewrites its own config file
  // constantly — start counters, per-project state, cached flags — and hashing the file would light
  // RESTART for the whole fleet several times an hour, which is how a column stops being read.
  const path = write(
    'cfg/config.json',
    JSON.stringify({ numStartups: 1, mcpServers: { a: { command: 'x' } } }),
  );
  const before = jsonFieldDigest(path, 'mcpServers');
  writeFileSync(
    path,
    JSON.stringify({
      numStartups: 2,
      cached: { flags: [1, 2, 3] },
      mcpServers: { a: { command: 'x' } },
    }),
  );
  utimesSync(path, new Date(), new Date(Date.now() + 5_000)); // force a new mtime, defeat the cache
  expect(jsonFieldDigest(path, 'mcpServers')).toBe(before);
});

test('an MCP table digest DOES move when a server is added', () => {
  const path = write('cfg2/config.json', JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
  const before = jsonFieldDigest(path, 'mcpServers');
  writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));
  expect(jsonFieldDigest(path, 'mcpServers')).not.toBe(before);
});

test('the same configuration written in a different key order is not a change', () => {
  expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test('a TOML table digest ignores the project list the agent appends to the same file', () => {
  const path = write(
    'cfg3/config.toml',
    '[mcp_servers.node]\ncommand = "node"\n[projects."/a"]\ntrust = "on"\n',
  );
  const before = tomlTableDigest(path, 'mcp_servers');
  writeFileSync(
    path,
    '[mcp_servers.node]\ncommand = "node"\n[projects."/a"]\ntrust = "on"\n[projects."/b"]\ntrust = "on"\n',
  );
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));
  expect(tomlTableDigest(path, 'mcp_servers')).toBe(before);
});

test('an unparseable config says nothing rather than guessing', () => {
  const path = write('cfg4/config.json', '{ half-written');
  expect(jsonFieldDigest(path, 'mcpServers')).toBeNull();
});

// ── the environment the supervisor's runtime mixes in ────────────────────────────────────────────

test('the env files considered are the ones the runtime actually reads', () => {
  expect(envFiles('/p', undefined)).toEqual(['/p/.env', '/p/.env.local']);
  // NODE_ENV-specific files are read ONLY when NODE_ENV is set — measured, not assumed.
  expect(envFiles('/p', 'production')).toEqual([
    '/p/.env',
    '/p/.env.local',
    '/p/.env.production',
    '/p/.env.production.local',
  ]);
});

test('env parsing yields NAMES and never values', () => {
  const path = write('proj/.env', '# comment\nexport TOKEN=super-secret\nPLAIN=1\n\nbad line\n');
  expect(envFileKeys(path)).toEqual(['PLAIN', 'TOKEN']);
  const input = envInput({ dir: join(dir, 'proj'), envFile: '.env' });
  expect(input.keys).toEqual(['PLAIN', 'TOKEN']);
  expect(JSON.stringify(input)).not.toContain('super-secret');
});

test('the stamp digests the DECLARED file — an undeclared one shapes nothing any more', () => {
  // The pane runs with --no-env-file and the recipe subtracts those names, so a file sitting in the
  // directory is no longer part of what the launch reads. The stamp has to describe the recipe, not
  // the accident it replaced.
  write('undeclared/.env', 'SECRET=x\n');
  expect(envInput({ dir: join(dir, 'undeclared') }).digest).toBeNull();
  expect(inheritedEnvInput(join(dir, 'undeclared'), undefined).keys).toEqual(['SECRET']);
});

test("a session with no declared file contributes a stable absence, not a false 'changed'", () => {
  const input = envInput({ dir: join(dir, 'no-env-here') });
  expect(input.digest).toBeNull();
  expect(input.paths).toEqual([]);
});

// ── what the RESTART column now says ─────────────────────────────────────────────────────────────

const stamp = (over: Partial<LaunchStamp> = {}): LaunchStamp => ({
  version: '0.0.0',
  hash: 'h',
  permissionMode: 'auto',
  chatEnabled: true,
  dir: '/src/agent-a',
  promptModules: [],
  envKeys: [],
  inputs: { rules: 'r1', mcp: 'm1', env: null },
  ts: 0,
  ...over,
});
const now = (over: Partial<LaunchStamp> = {}): Omit<LaunchStamp, 'ts'> => {
  const { ts, ...rest } = stamp(over);
  void ts;
  return rest;
};

test("a changed rule set is reported as 'rules', not as a generic 'config'", () => {
  // The word matters: "restart to pick up new rules" and "restart to pick up a new MCP server" are
  // different sentences to somebody deciding whether to bounce a session mid-task.
  expect(staleReasons(stamp(), now({ inputs: { rules: 'r2', mcp: 'm1', env: null } }))).toEqual([
    'rules',
  ]);
  expect(staleReasons(stamp(), now({ inputs: { rules: 'r1', mcp: 'm2', env: null } }))).toEqual([
    'mcp',
  ]);
});

test('an env file that appeared (or changed) since launch is reported', () => {
  expect(staleReasons(stamp(), now({ inputs: { rules: 'r1', mcp: 'm1', env: 'e1' } }))).toEqual([
    'env',
  ]);
});

test('a stamp written before inputs existed is UNKNOWN, never stale', () => {
  // Same doctrine as a missing stamp: the first upgrade of ccmux itself must not paint the fleet red.
  expect(
    staleReasons(stamp({ inputs: null }), now({ inputs: { rules: 'r9', mcp: 'm9', env: 'e9' } })),
  ).toEqual([]);
});

test('nothing changed → nothing reported, and the env reason is not doubled', () => {
  expect(staleReasons(stamp(), now())).toEqual([]);
  // `env` can arrive from the ccmux-injected key list AND from the input map; it must be said once.
  const out = staleReasons(
    stamp({ envKeys: ['A'] }),
    now({ envKeys: ['A', 'B'], inputs: { rules: 'r1', mcp: 'm1', env: 'e1' } }),
  );
  expect(out).toEqual(['env']);
});
