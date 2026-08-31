import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanPublicationPatch, scanPublicationText } from '../scripts/publication-privacy.ts';

const machineLabel = ['NODE', 'DEV'].join('-');
const homePath = ['/Users', 'fixture-account', 'work'].join('/');

describe('public publication boundary', () => {
  test('generic placeholders and technical release evidence remain public', () => {
    expect(
      scanPublicationText('host-A, agent-A, /Users/u/work, /home/u/work\nSHA-256: abc\nv0.1.0'),
    ).toEqual([]);
  });

  test('structural coordination fields and machine shapes fail without a private denylist', () => {
    const field = ['responsible', ': Codex · fixture'].join('');
    expect(scanPublicationText(`${field}\nRollout ${machineLabel}`)).toEqual([
      { line: 1, rule: 'operational-coordination-field' },
      { line: 2, rule: 'deployment-machine-label' },
    ]);
    const fixtureId = ['12345678', '1234', '1234', '1234', '123456789012'].join('-');
    const route = `Report to thread ${fixtureId}`;
    expect(scanPublicationText(route)[0]?.rule).toBe('private-return-route');
    expect(scanPublicationText(homePath)[0]?.rule).toBe('private-home-path');
  });

  test('deleting private text is allowed; added text is reported at its source line', () => {
    const patch = `--- a/doc.md\n+++ b/doc.md\n@@ -8,1 +8,1 @@\n-${machineLabel}\n+host-A\n`;
    expect(scanPublicationPatch(patch)).toEqual([]);
    expect(scanPublicationPatch(`@@ -0,0 +14,1 @@\n+${machineLabel}\n`)).toEqual([
      { line: 14, rule: 'deployment-machine-label' },
    ]);
  });

  test('real staged gate reads reviewed bytes, does not mutate index, and does not echo protected text', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-publication-'));
    const git = (args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    try {
      git(['init', '--quiet']);
      writeFileSync(join(root, 'doc.md'), `${machineLabel}\n${homePath}\n`);
      git(['add', 'doc.md']);
      const index = readFileSync(join(root, '.git', 'index'));
      writeFileSync(join(root, 'doc.md'), 'host-A\n/Users/u/work\n');
      const result = Bun.spawnSync(
        [process.execPath, '--no-env-file', resolve('scripts/check-publication.ts'), '--staged'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('deployment-machine-label');
      expect(result.stderr.toString()).not.toContain(machineLabel);
      expect(result.stderr.toString()).not.toContain(homePath);
      expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true);
      git(['add', 'doc.md']);
      const clean = Bun.spawnSync(
        [process.execPath, '--no-env-file', resolve('scripts/check-publication.ts'), '--staged'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(clean.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
