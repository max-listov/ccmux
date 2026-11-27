import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceBundle, restoreBackup } from '../src/release/update.ts';

test('concurrent duplicate release installs preserve the actual rollback predecessor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-swap-'));
  const app = join(root, 'stitchmux.js');
  writeFileSync(app, 'previous-release');
  const module = new URL('../src/release/update.ts', import.meta.url).href;
  try {
    const writers = Array.from({ length: 20 }, (_, i) => {
      const from = join(root, `candidate-${i}`);
      writeFileSync(from, 'next-release');
      return Bun.spawn(
        [
          process.execPath,
          '-e',
          'const {replaceBundle}=await import(process.env.STITCHMUX_TEST_MODULE);await replaceBundle(process.env.STITCHMUX_TEST_FROM,process.env.STITCHMUX_TEST_TARGET);',
        ],
        {
          env: {
            ...process.env,
            STITCHMUX_TEST_MODULE: module,
            STITCHMUX_TEST_FROM: from,
            STITCHMUX_TEST_TARGET: app,
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );
    });
    for (const writer of writers) {
      const errors = await new Response(writer.stderr).text();
      expect(await writer.exited, errors).toBe(0);
    }
    expect(readFileSync(app, 'utf8')).toBe('next-release');
    expect(readFileSync(`${app}.bak`, 'utf8')).toBe('previous-release');
    expect(existsSync(`${app}.update-lock`)).toBe(false);
    for (let i = 0; i < 20; i++) expect(existsSync(join(root, `candidate-${i}`))).toBe(false);
    const repeat = join(root, 'repeat');
    writeFileSync(repeat, 'next-release');
    await replaceBundle(repeat, app);
    expect(readFileSync(`${app}.bak`, 'utf8')).toBe('previous-release');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('a failed rollback backup leaves the live bundle and candidate intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-swap-fail-'));
  const app = join(root, 'stitchmux.js');
  const from = join(root, 'candidate');
  writeFileSync(app, 'previous-release');
  writeFileSync(from, 'next-release');
  mkdirSync(`${app}.bak`);
  try {
    await expect(replaceBundle(from, app)).rejects.toThrow();
    expect(readFileSync(app, 'utf8')).toBe('previous-release');
    expect(readFileSync(from, 'utf8')).toBe('next-release');
    expect(existsSync(`${app}.update-lock`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback restores the predecessor and reports a missing backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-rollback-ok-'));
  const app = join(root, 'stitchmux.js');
  writeFileSync(app, 'broken-release');
  try {
    expect(await restoreBackup(app)).toBe(false);
    writeFileSync(`${app}.bak`, 'previous-release');
    expect(await restoreBackup(app)).toBe(true);
    expect(readFileSync(app, 'utf8')).toBe('previous-release');
    expect(readdirSync(root).sort()).toEqual(['stitchmux.js', 'stitchmux.js.bak']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
