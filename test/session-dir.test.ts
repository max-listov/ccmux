import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleReasons } from '../src/agent/launchStamp.ts';
import {
  findSession,
  loadSessions,
  setSessionDir,
  writeSessionsUnlocked,
} from '../src/config/sessions.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * A session outlives the layout of the disk under it.
 *
 * Checkouts get reorganised — sources, private working area and media collected under one folder —
 * and every session on the old path is then registered against a directory that is no longer the
 * project. Until this existed the only way back was to recreate the session, which throws away the
 * conversation; that price is paid by whoever tidies a machine, which is why nobody tidied one.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-session-dir-'));
  roots.push(root);
  const m = makeMachine({ stateDir: join(root, 'state') });
  const before = join(root, 'project');
  const after = join(root, 'project', 'src');
  mkdirSync(after, { recursive: true });
  return { m, before, after };
}

test('only the named session moves, and one sharing the directory stays', async () => {
  const { m, before, after } = fixture();
  await writeSessionsUnlocked(m, [
    makeSession({ name: 'agent-a', dir: before }),
    makeSession({ name: 'agent-b', dir: before }),
  ]);
  expect(await setSessionDir(m, 'agent-a', after)).toBe(true);
  const sessions = loadSessions(m);
  expect(findSession(sessions, 'agent-a')?.dir).toBe(after);
  // Two agents on one checkout is an ordinary arrangement; moving one must not move the other.
  expect(findSession(sessions, 'agent-b')?.dir).toBe(before);
});

test('a name that is not registered is refused rather than invented', async () => {
  const { m, after } = fixture();
  await writeSessionsUnlocked(m, []);
  expect(await setSessionDir(m, 'agent-a', after)).toBe(false);
});

test('a moved session reads as needing a restart, and one that never moved does not', () => {
  // The case that hides: the parent folder kept the old name, so the registered path still EXISTS
  // and looks right while pointing one level above the sources. "Does the directory exist" would
  // pass it; comparing what the session was LAUNCHED in against what it is registered in does not.
  const launched = {
    version: '0',
    hash: 'h',
    permissionMode: 'auto',
    chatEnabled: true,
    promptModules: [],
    envKeys: null,
    inputs: null,
    dir: '/work/project',
    ts: 0,
  };
  expect(staleReasons(launched, { ...launched, dir: '/work/project/src' })).toContain('dir');
  expect(staleReasons(launched, { ...launched })).not.toContain('dir');
  // A stamp written before this field says nothing about it: unknown is never stale.
  expect(
    staleReasons({ ...launched, dir: null }, { ...launched, dir: '/elsewhere' }),
  ).not.toContain('dir');
});
