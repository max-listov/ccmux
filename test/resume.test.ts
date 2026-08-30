import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDir, histFile, resumeArgs } from '../src/agent/claude/resume.ts';

const UUID = '11111111-1111-4111-8111-111111111111';

test('encodeDir: EVERY non-alphanumeric char → dash (matches Claude, not just slashes)', () => {
  // non-existent dirs → realpath falls back to raw → pure char-class encode
  expect(encodeDir('/home/u/api-bot')).toBe('-home-u-api-bot');
  // the bug this locks: dots / underscores / spaces must ALSO become dash, or the jsonl
  // isn't found → resume forks onto --session-id → "already in use" loop
  expect(encodeDir('/tmp/cc.dot_test')).toBe('-tmp-cc-dot-test');
  expect(encodeDir('/home/u/my project.v2')).toBe('-home-u-my-project-v2');
});

test('histFile composes projectsDir + encoded dir + uuid.jsonl', () => {
  expect(histFile('/home/u', UUID, '/root/.claude/projects')).toBe(
    `/root/.claude/projects/-home-u/${UUID}.jsonl`,
  );
});

test('P0-4 realpath: /tmp resolves to /private/tmp on macOS (symlink)', () => {
  if (process.platform !== 'darwin') return;
  // /tmp is a symlink to /private/tmp on macOS — Claude encodes the resolved path.
  expect(realpathSync('/tmp')).toBe('/private/tmp');
  expect(encodeDir('/tmp')).toBe('-private-tmp');
});

test('tripwire: histFile encoding byte-matches the real ~/.claude/projects layout', () => {
  // The one correctness coupling with Claude. If this fails, Claude changed its
  // project-dir encoding and resume is broken — fail CI loudly rather than silently
  // fork conversations onto --session-id.
  const home = '/Users/u/home';
  if (!existsSync(home)) return; // not this machine
  const encoded = encodeDir(home); // realpath-resolved
  expect(encoded).toBe('-Users-u-home');
  // a managed session runs in this dir — its project folder must exist, else encoding drifted
  if (existsSync('/Users/u/.claude/projects')) {
    expect(existsSync(`/Users/u/.claude/projects/${encoded}`)).toBe(true);
  }
  // symlinked paths resolve to the same project (Claude encodes the realpath)
  if (existsSync('/Users/u/Desktop/home')) {
    expect(encodeDir('/Users/u/Desktop/home')).toBe('-Users-u-home');
  }
});

test('resumeArgs flips on transcript existence — the whole resume contract', () => {
  const projects = mkdtempSync(join(tmpdir(), 'ccmux-proj-'));
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-work-'));
  // first launch: no jsonl → --session-id
  expect(resumeArgs(UUID, dir, projects)).toEqual(['--session-id', UUID]);
  // create the transcript at the realpath-encoded location
  const hist = histFile(dir, UUID, projects);
  const sub = hist.slice(0, hist.lastIndexOf('/'));
  Bun.spawnSync(['mkdir', '-p', sub]);
  writeFileSync(hist, '{}\n');
  expect(resumeArgs(UUID, dir, projects)).toEqual(['--resume', UUID]);
});
