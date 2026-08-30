import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { materializeCustomPackage } from '../src/agent/custom/package.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const entry = (text: string) => ({ sha256: sha(text), data: gzipSync(text).toString('base64') });
test('offline Custom package has one concurrent materialization and refuses retained-byte tampering', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ccmux-custom-package-'));
  roots.push(stateDir);
  const module = entry('export const value = 71;');
  const darwinArm64 = entry('arm64-fixture'),
    darwinX64 = entry('x64-fixture');
  const artifact = {
    module,
    darwinArm64,
    darwinX64,
    digest: sha(JSON.stringify([module.sha256, darwinArm64.sha256, darwinX64.sha256])),
  };
  const paths = await Promise.all(
    Array.from({ length: 16 }, () => materializeCustomPackage({ stateDir }, artifact)),
  );
  expect(new Set(paths).size).toBe(1);
  const url = paths[0];
  if (!url) throw new Error('Missing package path');
  expect((await import(url)).value).toBe(71);
  const path = fileURLToPath(url);
  await writeFile(path, 'corrupt', { mode: 0o600 });
  await expect(materializeCustomPackage({ stateDir }, artifact)).rejects.toThrow('checksum');
  expect(await readFile(path, 'utf8')).toBe('corrupt');
  await expect(
    materializeCustomPackage({ stateDir }, { ...artifact, digest: '0'.repeat(64) }),
  ).rejects.toThrow('manifest');
});
