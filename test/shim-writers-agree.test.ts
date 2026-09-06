import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { shimContents } from '../src/config/installedApp.ts';

/**
 * Two programs write `~/.local/bin/ccmux`: the installer, before any of our code can run, and the
 * daemon, which converges it on every start. They must produce the same bytes — otherwise each
 * rewrites the other's work forever, the installer reports a change it did not keep, and a routing
 * decision that lives in that file is true only until the next daemon start.
 *
 * The installer's line is executed rather than eyeballed: a template compared as text would pass
 * while `printf` interpreted it differently.
 */
test('the installer and the daemon write the same PATH shim, byte for byte', async () => {
  const installer = readFileSync(join(import.meta.dir, '..', 'scripts', 'install.sh'), 'utf8');
  const line = installer.split('\n').find((row) => row.startsWith('WANT_SHIM='));
  expect(line).toBeDefined();
  // Both sides are asked about the SAME install: the shim names the bundle it routes to, and the
  // installer is handed that bundle's directory. Anything else compares two different machines.
  const written = shimContents();
  const bundle = /exec "[^"]+" "([^"]+ccmux\.js|[^"]+\.ts)" "\$@"/.exec(written)?.[1];
  expect(bundle).toBeDefined();
  const exec = process.execPath;
  const appDir = dirname(bundle ?? '');
  const proc = Bun.spawn(
    ['sh', '-c', `BUN=${exec}; APP_DIR=${appDir}; ${line}; printf '%s\\n' "$WANT_SHIM"`],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const fromInstaller = await new Response(proc.stdout).text();
  await proc.exited;
  expect(fromInstaller).toBe(written.replace(/ccmux\.js|[^"/]+\.ts/, 'ccmux.js'));
});

test('the installed shim fails when its required program is missing, without running the bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-shim-'));
  try {
    const installer = readFileSync(join(import.meta.dir, '..', 'scripts', 'install.sh'), 'utf8');
    const line = installer.split('\n').find((row) => row.startsWith('WANT_SHIM='));
    expect(line).toBeDefined();
    const render = Bun.spawn(['sh', '-c', `${line}; printf '%s\\n' "$WANT_SHIM"`], {
      env: { ...process.env, BUN: process.execPath, APP_DIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const shim = join(dir, 'ccmux');
    writeFileSync(shim, await new Response(render.stdout).text());
    expect(await render.exited).toBe(0);
    writeFileSync(join(dir, 'ccmux.js'), 'console.log("BUNDLE_EXECUTED")');
    const missing = Bun.spawn(['sh', shim, 'status-line'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(missing.stdout).text(),
      new Response(missing.stderr).text(),
      missing.exited,
    ]);
    expect(code).not.toBe(0);
    expect(err).toContain('status-line.js');
    expect(out).not.toContain('BUNDLE_EXECUTED');
    writeFileSync(join(dir, 'status-line.js'), 'console.log("STATUS_LINE_EXECUTED")');
    for (const [verb, expected] of [
      ['status-line', 'STATUS_LINE_EXECUTED'],
      ['version', 'BUNDLE_EXECUTED'],
    ] as const) {
      const proc = Bun.spawn(['sh', shim, verb], { stdout: 'pipe', stderr: 'pipe' });
      expect((await new Response(proc.stdout).text()).trim()).toBe(expected);
      expect(await proc.exited).toBe(0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
