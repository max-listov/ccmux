import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { transcriptJson } from '../src/commands/transcript.ts';
import { appendSession } from '../src/config/sessions.ts';
import { ControlTranscriptReadSchema } from '../src/control/schema.ts';
import { readControlTranscript } from '../src/control/transcript.ts';
import { makeMachine, makeSession } from './helpers.ts';

const UUID = 'a1b2c3d4-0000-4000-8000-000000000001';

const record = (n: number) =>
  JSON.stringify({
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    timestamp: '2026-09-02T10:00:00.000Z',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `line ${n}` }] },
  });

async function setup(lines: number) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-control-transcript-'));
  const dir = join(root, 'proj');
  mkdirSync(dir, { recursive: true });
  const projectsDir = join(root, 'projects');
  const projDir = join(projectsDir, encodeDir(dir));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, `${UUID}.jsonl`),
    `${Array.from({ length: lines }, (_, i) => record(i + 1)).join('\n')}\n`,
  );
  const m = makeMachine({ projectsDir, stateDir: root });
  const session = makeSession({ name: 'agent-a', dir, uuid: UUID, agent: 'claude' });
  await appendSession(m, session);
  return { m, session };
}

const target = (machine: string) =>
  ({
    kind: 'managed',
    source: 'ccmux',
    agent: 'claude',
    machine,
    session: 'agent-a',
    threadId: UUID,
  }) as const;

test('the service answers the same window as the command, from one builder', async () => {
  const { m, session } = await setup(400);
  const overService = readControlTranscript(
    m,
    ControlTranscriptReadSchema.parse({ target: target(m.rcPrefix), tail: 20 }),
  );
  const overCommand = transcriptJson(m, session, { tail: 20 });
  // Everything except the instant the answer was generated. Two builders of one answer drift, and
  // this one carries the cursor a consumer pages by — a drift here is a consumer walking through a
  // slightly different conversation depending on how it asked.
  expect({ ...overService, generatedAt: '', target: undefined }).toEqual({
    ...overCommand,
    generatedAt: '',
    target: undefined,
  });
  expect(overService.messages).toHaveLength(20);
  expect(overService.window.lastLine).toBe(400);
  expect(overService.target).toEqual(target(m.rcPrefix));
});

test('a cursor asks for what came after it, and the answer says where it now ends', async () => {
  const { m } = await setup(400);
  const answer = readControlTranscript(
    m,
    ControlTranscriptReadSchema.parse({ target: target(m.rcPrefix), cursor: 397 }),
  );
  expect(answer.window.firstLine).toBe(398);
  expect(answer.messages).toHaveLength(3);
  // The cursor to hand back next time is the end of the file, not the end of this window.
  expect(answer.cursor.line).toBe(400);
});

test('the window a caller may ask for is bounded, and the refusal names the field', () => {
  // The answer travels a response budget. Refusing here says which number was too large; letting it
  // through says only that something was too big, at the transport, after the work was done.
  const tooMany = ControlTranscriptReadSchema.safeParse({ target: target('host-a'), tail: 5_000 });
  expect(tooMany.success).toBe(false);
  expect(tooMany.error?.issues[0]?.path).toEqual(['tail']);
  const tooWide = ControlTranscriptReadSchema.safeParse({
    target: target('host-a'),
    textLimit: 100_000,
  });
  expect(tooWide.success).toBe(false);
  expect(tooWide.error?.issues[0]?.path).toEqual(['textLimit']);
  // And the ordinary ask needs nothing but a target: the defaults are the command's defaults.
  const plain = ControlTranscriptReadSchema.parse({ target: target('host-a') });
  expect(plain.tail).toBe(120);
  expect(plain.cursor).toBeNull();
});
