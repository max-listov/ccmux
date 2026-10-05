import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeCompanion, requireUniversalNativePackaging } from '../scripts/native-companion.ts';

// The manifest is the owner's published digest, read here without Stitchkit's own packaging
// reader, so agreement is two independent paths to the same bytes.
const manifestPath = join(
  dirname(Bun.resolveSync('stitchkit/package.json', import.meta.dir)),
  'native-assets.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  formatVersion: number;
  assets: Record<string, { path: string; size: number; sha256: string }>;
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('the embedded native companion bytes are the ones the owner published', () => {
  expect(manifest.formatVersion).toBe(2);
  const packaging = requireUniversalNativePackaging('app/ccmux.js');
  for (const architecture of ['arm64', 'x64'] as const) {
    const published = manifest.assets[architecture];
    const asset = nativeCompanion(packaging, architecture);
    expect(published).toBeDefined();
    expect(asset.sha256).toBe(published?.sha256 ?? '');
    expect(asset.size).toBe(published?.size ?? -1);
    expect(sha256(asset.bytes)).toBe(published?.sha256 ?? '');
  }
});

test('a changed byte no longer matches the published digest', () => {
  const asset = nativeCompanion(requireUniversalNativePackaging('app/ccmux.js'), 'arm64');
  const changed = Uint8Array.from(asset.bytes);
  changed[0] = (changed[0] ?? 0) ^ 0xff;
  expect(sha256(changed)).not.toBe(asset.sha256);
});

// Stitchkit's own refusal, exercised on a copy of the installed package whose addon has one byte
// changed after the manifest was written — the substitution the published digest exists to catch.
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function packagingOutcome(tamper: boolean) {
  const installed = dirname(Bun.resolveSync('stitchkit/package.json', import.meta.dir));
  const outer = join(installed, '..');
  const root = mkdtempSync(join(tmpdir(), 'ccmux-stitchkit-copy-'));
  roots.push(root);
  const modules = join(root, 'node_modules');
  mkdirSync(modules);
  const copy = join(modules, 'stitchkit');
  cpSync(installed, copy, { recursive: true });
  // Everything else Stitchkit needs resolves from this copy's own node_modules.
  const manifestOfPackage = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  for (const name of Object.keys({
    ...manifestOfPackage.dependencies,
    ...manifestOfPackage.peerDependencies,
  })) {
    if (!existsSync(join(outer, name))) continue;
    mkdirSync(dirname(join(modules, name)), { recursive: true });
    symlinkSync(join(outer, name), join(modules, name));
  }
  if (tamper) {
    const addon = join(copy, 'native', 'darwin-arm64.node');
    const bytes = readFileSync(addon);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(addon, bytes);
  }
  const entry = join(copy, 'dist', 'entrypoints', 'files', 'packaging.js');
  const script = `import { createNativePackaging } from ${JSON.stringify(entry)};
    const r = createNativePackaging({ platform: 'darwin', architecture: ['arm64', 'x64'],
      delivery: 'companion', entryPath: 'app/ccmux.js',
      assetPath: { arm64: 'native/darwin-arm64.node', x64: 'native/darwin-x64.node' } });
    console.log(JSON.stringify({ state: r.state, code: r.code, architecture: r.architecture }));`;
  const out = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return JSON.parse(out.stdout.toString().trim().split('\n').pop() ?? '{}');
}

test('Stitchkit packaging refuses an addon changed after its digest was published', () => {
  // Positive control: the untouched copy is ready, so the refusal below is the byte change.
  expect(packagingOutcome(false)).toMatchObject({ state: 'ready' });
  expect(packagingOutcome(true)).toMatchObject({
    state: 'mismatch',
    code: 'NATIVE_ASSET_DIGEST_MISMATCH',
    architecture: 'arm64',
  });
});
