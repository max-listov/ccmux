import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageSource } from '../scripts/package-source.ts';

test('source package is deterministic and contains bytes from the exact commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ccmux-source-package-'));
  try {
    const first = packageSource(join(directory, 'first'), '0.0.0');
    const second = packageSource(join(directory, 'second'), '0.0.0');
    expect(readFileSync(first)).toEqual(readFileSync(second));
    const member = 'src/control/schema/contract.ts';
    const expected = Bun.spawnSync(['git', 'show', `HEAD:${member}`]);
    const packed = Bun.spawnSync(['tar', '-xOf', first, `package/${member}`]);
    expect(expected.exitCode).toBe(0);
    expect(packed.exitCode).toBe(0);
    expect(packed.stdout).toEqual(expected.stdout);
    const absent = Bun.spawnSync(['tar', '-xOf', first, 'package/.env']);
    expect(absent.exitCode).not.toBe(0);
    expect(() => packageSource(directory, '../../escape')).toThrow('Invalid');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Two whole packs of the source. The suite's 20 s is for a hang; at load average 160 the packs
  // alone took longer, and that says nothing about whether they are the same bytes.
}, 60_000);
