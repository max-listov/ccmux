import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStatusLineApp } from '../src/config/statusLineInstall.ts';

// Build in the release process shape, outside the test runner's module resolver/cache.
// A fresh standalone test run otherwise rejects existing relative imports in the custom driver,
// while the identical Bun.build invocation outside bun:test resolves them successfully.
async function buildBundle(out: string): Promise<boolean> {
  const builder = join(import.meta.dir, '..', 'scripts', 'bundle.ts');
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {buildBundle} from ${JSON.stringify(builder)}; process.exit(await buildBundle(process.argv[1]) ? 0 : 1);`,
      out,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  return (await proc.exited) === 0;
}

// The prod bundle must be TRULY self-contained: it starts with no bun cache and no network. This is
// the exact failure that shipped for months invisibly — ink's hoisted `import "react-devtools-core"`
// resolved at load against the global cache, so a cache-cleared / offline machine died on start with
// ENOENT. The guard builds via the SAME `buildBundle` the release uses, then runs the bundle under
// full isolation. It catches react-devtools-core AND any future hoisted external ink (or a dep) adds.

test('the shipped bundle carries no react-devtools-core import (the specific regression)', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'ccmux-bundle-')), 'ccmux.js');
  expect(await buildBundle(out)).toBe(true);
  expect(readFileSync(out, 'utf8')).not.toContain('from "react-devtools-core"');
}, 60_000);

test('the shipped bundle starts with an EMPTY bun cache and NO network (the real invariant)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-bundle-iso-'));
  const out = join(dir, 'ccmux.js');
  expect(await buildBundle(out)).toBe(true);

  // Isolate resolution: a fresh empty HOME (⇒ empty ~/.bun cache), an empty cache dir, and a dead
  // registry — so a leftover hoisted external import cannot be satisfied by cache OR auto-install.
  // A regressed bundle dies here with `Cannot find package '…'`; a self-contained one just runs.
  const fakeHome = join(dir, 'home');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = fakeHome;
  env.BUN_INSTALL_CACHE_DIR = join(fakeHome, '.bun', 'install', 'cache');
  env.BUN_CONFIG_REGISTRY = 'http://127.0.0.1:1'; // nothing listens → no network install

  const proc = Bun.spawn(['bun', out, 'version'], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).not.toContain('Cannot find package');
  expect(code).toBe(0);
  expect(stdout).toContain('ccmux');
}, 60_000);

test('the shipped bundle carries the status-line program, and it runs on its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-bundle-sl-'));
  const out = join(dir, 'ccmux.js');
  expect(await buildBundle(out)).toBe(true);
  // The source module is null on purpose, so a build that failed to replace it would ship a bundle
  // whose required status-line program could never be installed.
  expect(readFileSync(out, 'utf8')).not.toContain('STATUS_LINE_ARTIFACT = null');

  // And the embedded bytes are the program itself: gunzip, hand them to the installer, run the file.
  const artifact = /STATUS_LINE_ARTIFACT = (\{[^}]+\})/.exec(readFileSync(out, 'utf8'))?.[1];
  expect(artifact).toBeDefined();
  const parsed = JSON.parse((artifact ?? '{}').replace(/(\w+):/g, '"$1":')) as {
    data: string;
    sha256: string;
  };
  const app = join(dir, 'status-line.js');
  await expect(ensureStatusLineApp(null, app)).rejects.toThrow(
    'Required status-line artifact is missing',
  );
  expect(await ensureStatusLineApp(parsed, app)).toBe('written');
  expect(await ensureStatusLineApp(parsed, app)).toBe('current'); // convergent, not rewritten
  const installRoot = join(dir, 'installed');
  for (const expected of ['written', 'current']) {
    const install = Bun.spawn([process.execPath, out, 'install', '--artifacts-only'], {
      env: { ...process.env, HOME: dir, CCMUX_DATA_DIR: installRoot },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(install.stdout).text();
    expect(await install.exited).toBe(0);
    expect(stdout.trim()).toBe(expected);
  }
  expect(readFileSync(join(installRoot, 'app', 'status-line.js'), 'utf8')).toBe(
    readFileSync(app, 'utf8'),
  );
  const proc = Bun.spawn([process.execPath, app], {
    stdin: new Response('{"model":{"display_name":"M"},"context_window":{"used_percentage":5}}'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: dir, CCMUX_SESSION: '' },
  });
  expect(await proc.exited).toBe(0);
}, 120_000);
