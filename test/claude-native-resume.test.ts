import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClaudeSdkDriver } from 'stitchkit/agent-executor/claude-sdk';
import { histFile } from '../src/agent/claude/resume.ts';

/**
 * Stitchkit's Claude SDK driver decides `sessionId` vs `resume` from whether the transcript file
 * actually exists on disk, so a session that never persisted a turn starts fresh while an existing
 * conversation resumes cleanly.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function probeOpenOptions(withTranscript: boolean): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-native-resume-'));
  roots.push(root);
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const id = '9850b4af-8986-4a79-bb28-b1f62bd9a9ba';
  if (withTranscript) {
    const path = histFile(work, id, join(root, 'projects'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
  }
  let captured: Record<string, unknown> = {};
  const driver = createClaudeSdkDriver({
    query: ({ options }) => {
      captured = (options ?? {}) as Record<string, unknown>;
      return {
        async *[Symbol.asyncIterator]() {},
        interrupt: async () => {},
        supportedModels: async () => [],
        close: () => {},
      };
    },
    sdkVersion: 'test',
  });
  const session = await driver.open({
    profile: { engine: 'claude-sdk', profileId: 'local', home: root },
    cwd: work,
    nativeThreadId: id,
  });
  await session.supportedModels();
  await session.close();
  return captured;
}

test('an absent transcript starts fresh with sessionId instead of resuming a missing conversation', async () => {
  const options = await probeOpenOptions(false);
  expect(options.sessionId).toBe('9850b4af-8986-4a79-bb28-b1f62bd9a9ba');
  expect(options.resume).toBeUndefined();
});

test('an existing transcript resumes the pinned conversation id', async () => {
  const options = await probeOpenOptions(true);
  expect(options.resume).toBe('9850b4af-8986-4a79-bb28-b1f62bd9a9ba');
  expect(options.sessionId).toBeUndefined();
});
