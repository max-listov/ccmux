import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedPeer } from '../src/chat/identity.ts';
import { makeChatMessage, makeMachine, makeSession } from './helpers.ts';

/**
 * Reading someone else's inbox changes nothing, and the listing says so.
 *
 * The two commands look identical and print the same thing, so having seen the mail reads as having
 * handled it. It is not handled: the letters are still queued, and the sender who "closed" them this
 * way keeps reporting an empty queue while two letters wait on a delivery that is not coming.
 */
const root = mkdtempSync(join(tmpdir(), 'ccmux-inbox-notice-'));
// The listing asks tmux whether the recipient is running, which only colours the hold sentence.
// A stub that lists nothing keeps the test about the read cursor and off the machine's tmux.
const tmuxBin = join(root, 'tmux');
writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
chmodSync(tmuxBin, 0o755);
const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a', tmuxBin });
const configPath = join(root, 'machine.json');
const session = makeSession({ name: 'agent-b' });
const message = makeChatMessage({ to: managedPeer(machine.rcPrefix, session), body: 'a letter' });
writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
writeFileSync(join(root, 'sessions.jsonl'), `# v2\n${JSON.stringify(session)}\n`);
writeFileSync(join(root, 'chat.jsonl'), `${JSON.stringify(message)}\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const NOTICE = 'nothing marked read';

async function inbox(env: Record<string, string>): Promise<string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) base[key] = value;
  base.CCMUX_CONFIG = configPath;
  base.CCMUX_STATE_DIR = root;
  base.CCMUX_CACHE_DIR = join(root, 'cache');
  delete base.CCMUX_SESSION;
  const proc = Bun.spawn(['bun', CLI, 'inbox', session.name], {
    env: { ...base, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  return out + err;
}

const cursors = (): string => {
  try {
    return readFileSync(join(root, 'chat-cursors.json'), 'utf8');
  } catch {
    return '';
  }
};

test('another session’s inbox is a diagnosis, and the listing says nothing was marked read', async () => {
  const out = await inbox({});
  expect(out).toContain('a letter');
  expect(out).toContain(NOTICE);
  expect(cursors()).not.toContain('"read"');
});

test('your own inbox marks read and does not claim otherwise', async () => {
  const out = await inbox({ CCMUX_SESSION: session.name });
  expect(out).toContain('a letter');
  expect(out).not.toContain(NOTICE);
  expect(cursors()).toContain('"read"');
});
