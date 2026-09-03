import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resumesConversation } from '../src/agent/claude/native/resume.ts';
import { histFile } from '../src/agent/claude/resume.ts';

/**
 * A session that never took a turn must not be sentenced to a conversation that was never written.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { marker: boolean; conversation: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-native-resume-'));
  roots.push(root);
  const m = { projectsDir: join(root, 'projects') };
  const session = {
    dir: join(root, 'work'),
    nativeSession: { runtime: 'claude' as const, id: '9850b4af-8986-4a79-bb28-b1f62bd9a9ba' },
  };
  const startedFile = join(root, 'conversation.started');
  if (options.marker) writeFileSync(startedFile, 'created\n');
  if (options.conversation) {
    const path = histFile(session.dir, session.nativeSession.id, m.projectsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
  }
  return { m, session, startedFile };
}

test('a marker without a conversation starts fresh instead of resuming forever', () => {
  // The exact state three sessions were found in: a marker written by the runtime's opening frame,
  // and no conversation anywhere under the projects directory. Resuming that id fails identically
  // on every start, so the session was blocked over a conversation with nothing in it.
  const { m, session, startedFile } = fixture({ marker: true, conversation: false });
  expect(resumesConversation(m, session as never, startedFile)).toBe(false);
});

test('a marker with its conversation still resumes it', () => {
  // The other half, and the reason this is not "always start new": a real conversation must never
  // be discarded because a start failed once.
  const { m, session, startedFile } = fixture({ marker: true, conversation: true });
  expect(resumesConversation(m, session as never, startedFile)).toBe(true);
});

test('a conversation without a marker is not resumed either', () => {
  // The marker still carries something the file cannot: that THIS supervisor started it. A file
  // that appeared some other way is not evidence to resume against.
  const { m, session, startedFile } = fixture({ marker: false, conversation: true });
  expect(resumesConversation(m, session as never, startedFile)).toBe(false);
});
