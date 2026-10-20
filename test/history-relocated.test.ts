import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findHistoryElsewhere, historyFile } from '../src/agent/claude/resume.ts';
import { makeMachine, makeSession, UUID } from './helpers.ts';

// Claude derives its history folder from the working directory, so renaming a project relocates the
// conversation while the registry still points at the old path. The expected file then does not
// exist — indistinguishable from a first launch unless someone looks for the uuid elsewhere. Live
// cost of not looking: a month-old conversation had a blank one written on top of it, same uuid.

function projects(): string {
  return mkdtempSync(join(tmpdir(), 'ccmux-hist-'));
}

function put(root: string, encodedDir: string, uuid: string, bytes: number): string {
  mkdirSync(join(root, encodedDir), { recursive: true });
  const path = join(root, encodedDir, `${uuid}.jsonl`);
  writeFileSync(path, 'x'.repeat(bytes));
  return path;
}

test('the conversation is found under the directory the project USED to have', () => {
  const root = projects();
  const s = makeSession({ dir: '/w/new-name', uuid: UUID });
  const m = makeMachine({ projectsDir: root });
  const moved = put(root, '-w-old-name', UUID, 5000);
  expect(findHistoryElsewhere(s, m).found).toBe(moved);
});

test('the FULLEST candidate wins — a fresh start is not mistaken for the history', () => {
  // The real shape of the incident: a nearly-empty file at the new path, the real conversation at the
  // old one. Picking by size is what keeps the answer pointing at the thing worth rescuing.
  const root = projects();
  const s = makeSession({ dir: '/w/new-name', uuid: UUID });
  const m = makeMachine({ projectsDir: root });
  put(root, '-w-tiny', UUID, 10);
  const big = put(root, '-w-old-name', UUID, 100_000);
  expect(findHistoryElsewhere(s, m).found).toBe(big);
});

test("the session's OWN path is never reported as elsewhere", () => {
  const root = projects();
  const s = makeSession({ dir: '/w/here', uuid: UUID });
  const m = makeMachine({ projectsDir: root });
  put(root, '-w-here', UUID, 1); // its own file, in its own place
  expect(historyFile(s, m)).toBe(join(root, '-w-here', `${UUID}.jsonl`));
  expect(findHistoryElsewhere(s, m).found).toBeNull();
});

test('a genuinely new session finds nothing — no false alarm on a first launch', () => {
  // The other half: this must stay silent for the case it is not about, or every new session would
  // be blocked from ever starting.
  const s = makeSession({ dir: '/w/fresh', uuid: UUID });
  expect(findHistoryElsewhere(s, makeMachine({ projectsDir: projects() })).found).toBeNull();
});

test('a missing projects root is recorded as searched, not a failed read', () => {
  const s = makeSession({ dir: '/w/x', uuid: UUID });
  expect(
    findHistoryElsewhere(s, makeMachine({ projectsDir: '/nonexistent-projects-root' })),
  ).toEqual({ found: null, roots: ['/nonexistent-projects-root'], failures: [] });
});

test('an invalid projects root is an incomplete search, not proof that history is absent', () => {
  const root = join(projects(), 'not-a-directory');
  writeFileSync(root, 'x');
  const result = findHistoryElsewhere(makeSession(), makeMachine({ projectsDir: root }));
  expect(result.found).toBeNull();
  expect(result.roots).toEqual([root]);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]?.path).toBe(root);
  expect(result.failures[0]?.reason).toContain('ENOTDIR');
});

test('an expected project path that is a file fails the search; an unrelated file does not', () => {
  const root = projects();
  const s = makeSession({ dir: '/w/fresh', uuid: UUID });
  const m = makeMachine({ projectsDir: root });
  writeFileSync(join(root, 'unrelated-file'), 'x');
  expect(findHistoryElsewhere(s, m).failures).toEqual([]);
  writeFileSync(join(root, '-w-fresh'), 'x');
  const result = findHistoryElsewhere(s, m);
  expect(result.found).toBeNull();
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]?.path).toBe(historyFile(s, m));
  expect(result.failures[0]?.reason).toContain('ENOTDIR');
});

test('the expected path is not elsewhere when the projects root has a trailing slash', () => {
  const root = projects();
  const s = makeSession({ dir: '/w/here', uuid: UUID });
  put(root, '-w-here', UUID, 10);
  expect(findHistoryElsewhere(s, makeMachine({ projectsDir: `${root}/` })).found).toBeNull();
});
