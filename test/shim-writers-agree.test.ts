import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shimContents } from '../src/config/migrateBundle.ts';

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
