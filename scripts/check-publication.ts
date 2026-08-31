#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { scanPublicationPatch, scanPublicationText } from './publication-privacy.ts';

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error('Publication guard could not read Git state');
  return result.stdout.toString();
}

export function checkPublication(staged: boolean): number {
  const paths = staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0')
    : git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md']).split(
        '\0',
      );
  let count = 0;
  let scanned = 0;
  for (const path of new Set(paths.filter(Boolean))) {
    if (!staged && !existsSync(path)) continue;
    const findings = staged
      ? scanPublicationPatch(git(['diff', '--cached', '--no-ext-diff', '--unified=0', '--', path]))
      : scanPublicationText(readFileSync(path, 'utf8'));
    scanned++;
    for (const finding of findings) {
      // Do not repeat the protected bytes in diagnostics or CI output.
      console.error(`${path}:${finding.line}: publication privacy: ${finding.rule}`);
      count++;
    }
  }
  console.log(
    `Publication privacy: ${scanned} ${staged ? 'staged files' : 'Markdown files'}, ${count} findings`,
  );
  return count === 0 ? 0 : 1;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--staged'))
    throw new Error('Usage: check-publication.ts [--staged]');
  process.exitCode = checkPublication(args[0] === '--staged');
}
