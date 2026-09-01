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

  test('an address handed to a ccmux command is a private name in two halves', () => {
    // The shape that slipped past every other rule and reached a committed document: not a path,
    // not a frontmatter field, not a machine label — a fleet address, whose machine half and
    // session half are both private. Placeholders survive because that is how examples are
    // written here, and a rule that failed on them would be turned off within a day.
    // Composed, not written: the literal would be the very shape this rule rejects, and the staged
    // guard reads every file type — so the test would fail on itself at commit time.
    const address = `${'build'}:${'internal'}`;
    expect(scanPublicationText(`ccmux wait ${address} --timeout 600`).map((f) => f.rule)).toContain(
      'fleet-address',
    );
    expect(scanPublicationText('ccmux msg host-b:agent-a "text"').map((f) => f.rule)).not.toContain(
      'fleet-address',
    );
  });

  test('the companion is forbidden by its address, not by its name', () => {
    // The name alone is PUBLIC in this project — `ccmux-dev` is the launcher that runs the CLI
    // from source, and it appears in the README and the architecture notes. Only the repository
    // address means the private companion, and a rule that failed on the launcher would be
    // switched off within a day for being wrong about correct documentation.
    const rules = (text: string) => scanPublicationText(text).map((finding) => finding.rule);
    // Composed rather than written: a test that spells the forbidden address out would put it in
    // this repository, which is the leak the rule exists to prevent — and the staged guard, which
    // reads every file type rather than Markdown alone, would then fail on its own test.
    const address = `max-listov/${'ccmu'}${'x'}-dev`;
    expect(rules(`the queue lives in ${address}`)).toContain('private-companion-repository');
    expect(rules('run ccmux-dev to start from source')).toEqual([]);
    expect(rules('`~/.local/bin/ccmux-dev` → source launcher')).toEqual([]);
    expect(rules("mkdtempSync(join(tmpdir(), 'ccmux-dev-'))")).toEqual([]);
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
