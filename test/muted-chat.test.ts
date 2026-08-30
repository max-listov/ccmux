import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutedChatSessions } from '../src/commands/doctor.ts';
import { chatAuthPath, sessionsPath } from '../src/config/paths.ts';
import type { Session } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

// Sending is authenticated by a capability handed out at launch. A session started before that
// existed keeps RECEIVING, so nothing looks broken until someone tries to reply and hits a refusal —
// one-way traffic reads as working from the outside. This asks the machine a FACT instead.

function machineWith(sessions: Session[], withCredential: string[]) {
  const m = makeMachine({ stateDir: mkdtempSync(join(tmpdir(), 'ccmux-muted-')) });
  writeFileSync(sessionsPath(m), `${sessions.map((s) => JSON.stringify(s)).join('\n')}\n`);
  for (const name of withCredential) {
    const p = chatAuthPath(m, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'secret\n');
  }
  return m;
}

test('a chat-enabled session without the capability is named', () => {
  const m = machineWith([makeSession({ name: 'agent-a', chatEnabled: true })], []);
  expect(mutedChatSessions(m)).toEqual(['agent-a']);
});

test('a session that HAS the capability is not named', () => {
  const m = machineWith([makeSession({ name: 'agent-a', chatEnabled: true })], ['agent-a']);
  expect(mutedChatSessions(m)).toEqual([]);
});

test('a session with chat OFF is not named — it was never meant to send', () => {
  // Otherwise the check would report most of a fleet as broken and be ignored within a day.
  const m = machineWith([makeSession({ name: 'agent-a', chatEnabled: false })], []);
  expect(mutedChatSessions(m)).toEqual([]);
});

test('an archived session is not named — it is parked, not broken', () => {
  const m = machineWith([makeSession({ name: 'agent-a', chatEnabled: true, archived: true })], []);
  expect(mutedChatSessions(m)).toEqual([]);
});
