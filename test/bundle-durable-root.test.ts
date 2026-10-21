import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bootUnit from '../src/boot/install.ts';
import { ensureInstalledApp, ownsInstallation } from '../src/boot/installedApp.ts';
import * as nativeBackend from '../src/boot/nativeBackendInstall.ts';
import { DEFAULT_DATA_DIR } from '../src/config/paths.ts';
import { makeMachine, shortTempDir } from './helpers.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ccmux-roots-'));
}

/** The roots are read from the environment when paths.ts is first imported, so the layout question
 *  is answered in a child process with that environment set — the same way a real install sees it. */
function rootsUnder(root: string): {
  app: string;
  data: string;
  cache: string;
  staged: string;
  releases: string;
} {
  const script =
    'const p = await import("' +
    join(process.cwd(), 'src/config/paths.ts') +
    '"); console.log(JSON.stringify({app: p.APP_BUNDLE, data: p.DATA_DIR, cache: p.CACHE_DIR, staged: p.STAGED_BUNDLE, releases: p.RELEASES_DIR}));';
  const r = Bun.spawnSync(['bun', '-e', script], {
    env: {
      ...process.env,
      CCMUX_DATA_DIR: join(root, 'share', 'ccmux'),
      CCMUX_CACHE_DIR: join(root, 'cache', 'ccmux'),
    },
  });
  return JSON.parse(r.stdout.toString());
}

test('the bundle no longer lives under the cache root', () => {
  const root = tmpRoot();
  const p = rootsUnder(root);
  expect(p.app.startsWith(p.cache)).toBe(false);
  expect(p.app.startsWith(p.data)).toBe(true);
  // What a download or a build can rebuild stays disposable.
  expect(p.staged.startsWith(p.cache)).toBe(true);
  expect(p.releases.startsWith(p.cache)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test('wiping the cache root leaves the runnable code untouched', () => {
  const root = tmpRoot();
  const p = rootsUnder(root);
  mkdirSync(join(p.data, 'app'), { recursive: true });
  writeFileSync(p.app, '// the tool');
  mkdirSync(p.cache, { recursive: true });
  writeFileSync(join(p.cache, 'junk'), 'x');

  rmSync(p.cache, { recursive: true, force: true }); // the exact command that caused the incident

  expect(existsSync(p.app)).toBe(true);
  expect(readFileSync(p.app, 'utf8')).toBe('// the tool');
  rmSync(root, { recursive: true, force: true });
});

test('an isolated data root or a source run never owns the installed shim or boot unit', () => {
  expect(ownsInstallation(join(tmpdir(), 'isolated-ccmux-data'), false)).toBe(false);
  expect(ownsInstallation(DEFAULT_DATA_DIR, false)).toBe(true);
  expect(ownsInstallation(DEFAULT_DATA_DIR, true)).toBe(false);
});

test('a daemon that is not the installation leaves the boot unit alone', async () => {
  // This process runs from source with an isolated data root — the same two facts as a test's
  // daemon. Converging here once pointed the live systemd unit at a temporary bundle.
  const converge = spyOn(bootUnit, 'convergeBootUnit').mockResolvedValue(false);
  // A source run carries no embedded native artifact; that install is not what this case is about.
  const backend = spyOn(nativeBackend, 'ensureNativeBackend').mockResolvedValue('not-needed');
  try {
    await ensureInstalledApp(makeMachine({ stateDir: shortTempDir('ccmux-boot-owner-') }));
    expect(converge).not.toHaveBeenCalled();
  } finally {
    converge.mockRestore();
    backend.mockRestore();
  }
});
