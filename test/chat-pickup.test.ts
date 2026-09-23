import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { managedPeerKey } from '../src/chat/identity.ts';
import { ChatCursorsSchema } from '../src/chat/messageSchema.ts';
import { unreadFor } from '../src/chat/store.ts';
import {
  armPickup,
  chatTurnProgress,
  chatTurnProgressFromMessages,
  transcriptLineCount,
} from '../src/chat/turnProgress.ts';
import type { TranscriptMessage } from '../src/types.ts';
import { makeChatMessage, makeMachine, makePeer, makeSession } from './helpers.ts';

const ID = '11111111-1111-4111-8111-111111111111';

function message(role: 'user' | 'assistant' | 'system', text: string): TranscriptMessage {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    createdAt: null,
    role,
    kind: 'message',
    text,
    title: null,
    toolName: null,
    toolCallId: null,
    status: null,
    rawType: 'response_item',
    done: false,
    result: null,
    input: null,
    resultText: null,
    image: null,
    usage: null,
    doneAt: null,
    agent: null,
  };
}

function tool(): TranscriptMessage {
  return {
    ...message('assistant', ''),
    role: 'tool',
    kind: 'tool_call',
    text: null,
    toolName: 'shell',
  };
}

test('pickup waits for the exact immutable chat id', () => {
  expect(chatTurnProgressFromMessages([message('assistant', 'old answer')], ID)).toBe(
    'awaiting-pickup',
  );
  expect(
    chatTurnProgressFromMessages([message('user', `[chat from peer · id: ${ID}] hi`)], ID),
  ).toBe('running');
});

test('intermediate assistant commentary before a tool is not a completed reply', () => {
  const turn = [
    message('user', `[chat from peer · id: ${ID}] hi`),
    message('assistant', 'I will inspect it.'),
    tool(),
  ];
  expect(chatTurnProgressFromMessages(turn, ID)).toBe('running');
  expect(chatTurnProgressFromMessages([...turn, message('assistant', 'done')], ID)).toBe(
    'answered',
  );
});

test('an interrupted Codex turn releases its durable pickup without retrying the message', () => {
  const turn = [
    message('user', `[chat from peer · id: ${ID}] hi`),
    message(
      'system',
      '<turn_aborted>\nThe previous turn was interrupted on purpose.\n</turn_aborted>',
    ),
  ];
  expect(chatTurnProgressFromMessages(turn, ID)).toBe('interrupted');
});

test('crash after durable arm keeps one pickup barrier and hides the same ledger row from retry', () => {
  const recipient = makePeer({
    machine: 'host-a',
    session: 'agent-b',
    threadId: '22222222-2222-4222-8222-222222222222',
    agent: 'codex',
  });
  const msg = makeChatMessage({ id: ID, to: recipient });
  const cursors = ChatCursorsSchema.parse({});
  const key = managedPeerKey(recipient);
  armPickup(cursors, key, { msg, idx: 0 }, '2026-08-26T00:00:00.000Z', { transcriptLine: 42 });

  // JSON round-trip models a daemon crash/restart between the atomic cursor write and Enter.
  const restarted = ChatCursorsSchema.parse(JSON.parse(JSON.stringify(cursors)));
  expect(restarted.pickups[key]?.messageId).toBe(ID);
  expect(restarted.pickups[key]?.transcriptLine).toBe(42);
  expect(restarted.delivered[key]).toBe(1);
  expect(unreadFor(recipient, [msg], restarted)).toEqual([]);
});

const UUID = 'a1b2c3d4-0000-4000-8000-000000000002';
const say = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    uuid: crypto.randomUUID(),
    timestamp: '2026-09-15T10:00:00.000Z',
    type: role,
    message: { role, content: [{ type: 'text', text }] },
  });

function transcript(lines: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-chat-pickup-'));
  const dir = join(root, 'proj');
  // The session directory first: its encoded name resolves the real path, which differs from the
  // temporary one on macOS until the directory exists.
  mkdirSync(dir, { recursive: true });
  const projectsDir = join(root, 'projects');
  const history = join(projectsDir, encodeDir(dir));
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, `${UUID}.jsonl`), `${lines.join('\n')}\n`);
  return {
    root,
    m: makeMachine({ projectsDir, stateDir: root }),
    session: makeSession({ name: 'agent-a', dir, uuid: UUID, agent: 'claude' }),
  };
}

test('pickup is read from the line the letter was injected at, not from the whole history', () => {
  const history = Array.from({ length: 40 }, (_, i) => say('user', `old ${i}`));
  const answered = [say('user', `[chat from peer · id: ${ID}] hi`), say('assistant', 'done')];
  const before = transcript([...answered, ...history]);
  const after = transcript([...history, ...answered]);
  try {
    expect(transcriptLineCount(after.m, after.session)).toBe(42);
    // Armed after line 40: the marker written afterwards is found, and one only BEFORE that line is
    // not read at all — which is what keeps a delivery pass off the rest of a long transcript.
    expect(chatTurnProgress(after.m, after.session, { messageId: ID, transcriptLine: 40 })).toBe(
      'answered',
    );
    expect(chatTurnProgress(before.m, before.session, { messageId: ID, transcriptLine: 40 })).toBe(
      'awaiting-pickup',
    );
  } finally {
    rmSync(before.root, { recursive: true, force: true });
    rmSync(after.root, { recursive: true, force: true });
  }
});

test('a transcript shorter than its armed line was rewritten and is searched from the start', () => {
  // Reporting "not picked up" here would inject the same letter a second time.
  const t = transcript([say('user', `[chat from peer · id: ${ID}] hi`), say('assistant', 'done')]);
  try {
    expect(chatTurnProgress(t.m, t.session, { messageId: ID, transcriptLine: 5_000 })).toBe(
      'answered',
    );
    // A record written before the line was kept is read from the first line.
    expect(chatTurnProgress(t.m, t.session, { messageId: ID })).toBe('answered');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
