import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownsInstalledShim } from '../src/config/installedApp.ts';
import { DEFAULT_DATA_DIR } from '../src/config/paths.ts';

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

test('an isolated data root never owns the shared installed shim', () => {
  expect(ownsInstalledShim(join(tmpdir(), 'isolated-ccmux-data'), false)).toBe(false);
  expect(ownsInstalledShim(DEFAULT_DATA_DIR, false)).toBe(true);
  expect(ownsInstalledShim(DEFAULT_DATA_DIR, true)).toBe(false);
});
