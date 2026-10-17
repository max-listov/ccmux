import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lifecycleBlockPath } from '../src/config/paths.ts';
import { startHealed } from '../src/session/heal.ts';
import {
  readLifecycleBlock,
  sessionBlock,
  writeLifecycleBlock,
} from '../src/session/lifecycleBlocks.ts';
import { appendSession } from '../src/session/registry.ts';
import { SessionSchema } from '../src/session/schema.ts';
import { installedCodeDiffers } from '../src/session/supervisorCode.ts';
import { VERSION } from '../src/util/version.ts';
import { makeMachine } from './helpers.ts';

// A supervisor that outlived an update must not judge a session by the rules it was loaded with, and
// a block written by another version must not keep a session stopped under this one.

const UUID = '33333333-3333-4333-8333-333333333333';

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-supervisor-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const m = makeMachine({ stateDir });
  const session = SessionSchema.parse({ name: 'agent-a', dir: root, agent: 'claude', uuid: UUID });
  await appendSession(m, session);
  return { m, session };
}

function blockWrittenBy(m: ReturnType<typeof makeMachine>, version: string | null) {
  const path = lifecycleBlockPath(m, 'agent-a');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      name: 'agent-a',
      agent: 'claude',
      uuid: UUID,
      error: 'agent-a has a conversation, but it is missing',
      at: '2026-10-17T15:15:13.000Z',
      ...(version === null ? {} : { version }),
    }),
  );
}

test('a bundle that changed on disk makes the running supervisor stale; anything unknown does not', () => {
  expect(installedCodeDiffers('a', 'b')).toBe(true);
  expect(installedCodeDiffers('a', 'a')).toBe(false);
  // Replaced right now, unreadable, or run from sources: not evidence of a new version.
  expect(installedCodeDiffers('a', 'missing')).toBe(false);
  expect(installedCodeDiffers('a', null)).toBe(false);
  expect(installedCodeDiffers(null, 'b')).toBe(false);
  expect(installedCodeDiffers('missing', 'b')).toBe(false);
});

test('every block records the version that wrote it, whoever built it', async () => {
  const { m, session } = await world();
  await writeLifecycleBlock(m, sessionBlock(session, 'refused'));
  expect(readLifecycleBlock(m, 'agent-a')?.version).toBe(VERSION);
});

test('a block from an older version, or from before blocks carried a version, is tried again once', async () => {
  for (const writer of ['0.83.0', null]) {
    const { m } = await world();
    blockWrittenBy(m, writer);
    const started: string[] = [];
    await startHealed(m, 'agent-a', '/x', async (name) => void started.push(name));
    expect(started).toEqual(['agent-a']);
    expect(existsSync(lifecycleBlockPath(m, 'agent-a'))).toBe(false);
  }
});

test('a block written by this version stays final: the heal neither clears it nor starts the session', async () => {
  const { m, session } = await world();
  await writeLifecycleBlock(m, sessionBlock(session, 'refused'));
  const started: string[] = [];
  await startHealed(m, 'agent-a', '/x', async (name) => void started.push(name));
  expect(started).toEqual([]);
  expect(readLifecycleBlock(m, 'agent-a')?.version).toBe(VERSION);
});

test('a block written by a NEWER version than the daemon stays: no clear-and-restart loop', async () => {
  const { m } = await world();
  blockWrittenBy(m, '99.0.0');
  const started: string[] = [];
  await startHealed(m, 'agent-a', '/x', async (name) => void started.push(name));
  expect(started).toEqual([]);
  expect(readLifecycleBlock(m, 'agent-a')?.version).toBe('99.0.0');
});

test('without a block the session starts', async () => {
  const { m } = await world();
  const started: string[] = [];
  await startHealed(m, 'agent-a', '/x', async (name) => void started.push(name));
  expect(started).toEqual(['agent-a']);
});
