import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { histFile } from '../src/agent/claude/resume.ts';
import { parseSearch, searchFleet } from '../src/commands/search.ts';
import {
  answerLines,
  followIdentities,
  whoisAll,
  whoisFleet,
  whoisSchemas,
} from '../src/commands/whois.ts';
import { CorpusSearchJsonSchema } from '../src/context/corpusSearchSchema.ts';
import { sessionIdentities } from '../src/session/identity.ts';
import {
  SessionIdentitySchema,
  WhoisAnswerSchema,
  type WhoisEvent,
} from '../src/session/identitySchema.ts';
import { repositoryKey, repositoryOf } from '../src/session/repository.ts';
import { readQuestion } from '../src/session/whois.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * A program that saw a session by one of its names is owed the session itself — or a plain "that is
 * not one". The name nearest to it is a different session, and an answer that settles for it files
 * someone's work under the wrong project without anything looking wrong.
 */
const L = (o: unknown): string => JSON.stringify(o);

const NOW = '11111111-1111-4111-8111-111111111111';
const BEFORE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const REMOVED = '55555555-5555-4555-8555-555555555555';

/** A conversation file as the provider writes it: the title first, then dated records. */
const conversation = (id: string, title: string | null, cwd: string, said: [string, string][]) => [
  ...(title === null ? [] : [L({ type: 'custom-title', customTitle: title, sessionId: id })]),
  ...said.map(([text, at], index) =>
    L({
      type: 'user',
      uuid: `${id}-${index}`,
      sessionId: id,
      timestamp: at,
      cwd,
      message: { role: 'user', content: [{ type: 'text', text }] },
    }),
  ),
];

interface Fleet {
  root: string;
  m: MachineConfig;
  sessions: Session[];
  api: string;
  write(id: string, lines: string[]): void;
}

async function fleet(run: (f: Fleet) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-whois-')));
  try {
    const projectsDir = join(root, 'claude', 'projects');
    const api = join(root, 'work', 'api');
    mkdirSync(api, { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    const init = Bun.spawnSync(['git', 'init', '-q', api]);
    const remote = Bun.spawnSync([
      'git',
      '-C',
      api,
      'remote',
      'add',
      'origin',
      'git@example.com:acme/api.git',
    ]);
    expect([init.exitCode, remote.exitCode]).toEqual([0, 0]);
    const m = makeMachine({ projectsDir, rcPrefix: 'host-a', stateDir: join(root, 'state') });
    const write = (id: string, lines: string[]): void => {
      const path = histFile(api, id, projectsDir);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    };
    // agent-a has lived in two conversations: the one before a `/clear`, and the one it reads now.
    write(
      BEFORE,
      conversation(BEFORE, 'host-a-agent-a', api, [['the heron plan', '2026-09-01T10:00:00.000Z']]),
    );
    write(
      NOW,
      conversation(NOW, 'host-a-agent-a', api, [['and the kestrel', '2026-09-02T10:00:00.000Z']]),
    );
    // In the same directory: another session's conversation, one a person started by hand, and one
    // left by a session that has since been removed.
    write(
      OTHER,
      conversation(OTHER, 'host-a-agent-a-two', api, [['unrelated', '2026-09-03T10:00:00.000Z']]),
    );
    write(FOREIGN, conversation(FOREIGN, null, api, [['by hand', '2026-08-01T10:00:00.000Z']]));
    write(
      REMOVED,
      conversation(REMOVED, 'host-a-retired', api, [['old work', '2026-07-01T10:00:00.000Z']]),
    );
    const sessions = [
      makeSession({ name: 'agent-a', uuid: NOW, dir: api }),
      makeSession({ name: 'agent-a-two', uuid: OTHER, dir: api }),
    ];
    await run({ root, m, sessions, api, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an origin address names its repository whichever way it is written', () => {
  expect(repositoryKey('git@example.com:acme/api.git\n')).toBe('acme/api');
  expect(repositoryKey('https://example.com/acme/api')).toBe('acme/api');
  expect(repositoryKey('ssh://git@example.com:22/acme/api.git/')).toBe('acme/api');
  expect(repositoryKey('https://example.com/group/sub/api.git')).toBe('sub/api');
  // No owner in it: not half an answer.
  expect(repositoryKey('/srv/git/api.git')).toBe('git/api');
  expect(repositoryKey('api')).toBeNull();
  expect(repositoryKey('')).toBeNull();
});

test('a session is everything it has lived in, and nothing its neighbours have', async () => {
  await fleet(async ({ m, sessions, api }) => {
    const [a, two] = await sessionIdentities(m, sessions);
    expect(SessionIdentitySchema.parse(a)).toEqual(a as never);
    expect(a).toMatchObject({
      address: 'host-a:agent-a',
      machine: 'host-a',
      name: 'agent-a',
      provider: 'claude',
      title: 'host-a-agent-a',
      dir: api,
      repository: 'acme/api',
      running: null,
      conversation: NOW,
      createdAt: '2026-09-01T10:00:00.000Z',
      lastActivityAt: '2026-09-02T10:00:00.000Z',
    });
    // Oldest first; the hand-started and the removed session's files are nobody's lives here.
    expect(a?.conversations).toEqual([
      {
        id: BEFORE,
        current: false,
        firstAt: '2026-09-01T10:00:00.000Z',
        lastAt: '2026-09-01T10:00:00.000Z',
      },
      {
        id: NOW,
        current: true,
        firstAt: '2026-09-02T10:00:00.000Z',
        lastAt: '2026-09-02T10:00:00.000Z',
      },
    ]);
    expect(two?.conversations.map((life) => life.id)).toEqual([OTHER]);
    // An id another session reads now is that session's, whatever title its file opens with.
    const [alone] = await sessionIdentities(m, [
      sessions[0] as Session,
      makeSession({ name: 'agent-z', uuid: BEFORE, dir: api }),
    ]);
    expect(alone?.conversations.map((life) => life.id)).toEqual([NOW]);
    expect(await repositoryOf(join(api, 'no-such-directory'))).toBeNull();
  });
});

test('a title shared by two sessions gives neither of them the other files', async () => {
  await fleet(async ({ m, api }) => {
    // `cc-agent-a` and `agent-a` are launched under one title: an earlier file could be either's.
    const sessions = [
      makeSession({ name: 'agent-a', uuid: NOW, dir: api }),
      makeSession({ name: 'cc-agent-a', uuid: OTHER, dir: api }),
    ];
    const lives = (await sessionIdentities(m, sessions)).map((identity) =>
      identity.conversations.map((life) => life.id),
    );
    expect(lives).toEqual([[NOW], [OTHER]]);
  });
});

test('a window title is matched as a whole word, never by the nearest name', async () => {
  await fleet(async ({ m, sessions }) => {
    const ask = (query: string) => whoisFleet(m, query, { local: true, sessions });
    const byTitle = await ask('host-a-agent-a - Claude Code');
    expect(WhoisAnswerSchema.parse(byTitle)).toEqual(byTitle);
    expect([byTitle.found, byTitle.by, byTitle.session?.address]).toEqual([
      'session',
      'title',
      'host-a:agent-a',
    ]);
    expect(byTitle.session?.repository).toBe('acme/api');
    // The longer name is the other session, and only that one.
    expect((await ask('host-a-agent-a-two - Claude Code')).session?.address).toBe(
      'host-a:agent-a-two',
    );
    // Somebody else's window: a prefix of a title, a title with more after it, a similar name.
    for (const title of ['host-a-agent - Claude Code', 'host-a-agent-a-three', 'Agent-A notes']) {
      const none = await ask(title);
      expect([title, none.found, none.session, none.candidates]).toEqual([title, 'none', null, []]);
    }
    expect(answerLines(await ask('Agent-A notes'), 0)).toEqual([
      "'Agent-A notes' is not a ccmux session",
    ]);
  });
});

test('an address and a provider id — the current one or an earlier one — reach the same session', async () => {
  await fleet(async ({ m, sessions, api }) => {
    const ask = (query: string) => whoisFleet(m, query, { local: true, sessions });
    for (const [query, by] of [
      ['host-a:agent-a', 'address'],
      ['agent-a', 'address'],
      [NOW, 'conversation'],
      [BEFORE, 'conversation'],
      [BEFORE.toUpperCase(), 'conversation'],
    ] as const) {
      const answer = await ask(query);
      expect([query, answer.found, answer.by, answer.session?.address]).toEqual([
        query,
        'session',
        by,
        'host-a:agent-a',
      ]);
    }
    // Another machine's address is not this machine's session of the same name.
    expect((await ask('host-b:agent-a')).found).toBe('none');
    // An id no session reads or has read: the conversation itself, and whose it says it was.
    const stray = await ask(REMOVED);
    expect([stray.found, stray.by, stray.session]).toEqual(['conversation', 'conversation', null]);
    expect(stray.conversation).toEqual({
      provider: 'claude',
      id: REMOVED,
      machine: 'host-a',
      address: `external:claude:host-a#${REMOVED}`,
      title: 'host-a-retired',
      dir: api,
      repository: 'acme/api',
    });
    expect((await ask('99999999-9999-4999-8999-999999999999')).found).toBe('none');
  });
});

test('readQuestion tells an id, an address and a title apart', () => {
  expect(readQuestion(` ${NOW} `)).toEqual({ kind: 'conversation', id: NOW });
  expect(readQuestion('host-a:agent-a')).toEqual({
    kind: 'address',
    machine: 'host-a',
    name: 'agent-a',
  });
  expect(readQuestion('host-a-agent-a - Claude Code')).toEqual({
    kind: 'words',
    words: ['host-a-agent-a', '-', 'Claude', 'Code'],
  });
  // A title with a colon in it is still a title.
  expect(readQuestion('notes: host-a-agent-a').kind).toBe('words');
});

test('every machine is asked, and one that did not answer is not read as having no such session', async () => {
  await fleet(async ({ m, sessions }) => {
    const here = { ...m, fleet: { 'host-a': 'self', 'host-b': 'alias-b' } };
    const there = { ...m, rcPrefix: 'host-b' };
    const asked: string[][] = [];
    const peer =
      (answer: (argv: string[]) => Promise<unknown>) =>
      async (_m: MachineConfig, _machine: string, _alias: string | null, argv: string[]) => {
        asked.push(argv);
        return {
          code: 0,
          stdout: JSON.stringify(await answer(argv)),
          stderr: '',
          transportFailed: false,
          delivery: 'received' as const,
        };
      };
    const remote = peer((argv) =>
      argv.includes('--all')
        ? whoisAll(there, { local: true, sessions })
        : whoisFleet(there, argv.at(-1) as string, { local: true, sessions }),
    );

    // The title of a session on the other machine.
    const far = await whoisFleet(here, 'host-b-agent-a - Claude Code', {
      local: false,
      sessions,
      runPeer: remote,
    });
    expect(asked[0]).toEqual([
      'ccmux',
      'whois',
      '--local',
      '--json',
      '--',
      'host-b-agent-a - Claude Code',
    ]);
    expect([far.found, far.session?.address]).toEqual(['session', 'host-b:agent-a']);
    expect(far.machines).toEqual([
      { machine: 'host-a', status: 'asked' },
      { machine: 'host-b', status: 'asked' },
    ]);
    // A bare name both machines have: both, and no choice between them.
    const both = await whoisFleet(here, 'agent-a', { local: false, sessions, runPeer: remote });
    expect([both.found, both.session]).toEqual(['ambiguous', null]);
    expect(both.candidates.map((row) => row.session.address)).toEqual([
      'host-a:agent-a',
      'host-b:agent-a',
    ]);
    // An address names its machine, so only that machine is asked.
    asked.length = 0;
    const exact = await whoisFleet(here, 'host-b:agent-a', {
      local: false,
      sessions,
      runPeer: remote,
    });
    expect([exact.found, exact.session?.address, asked.length]).toEqual([
      'session',
      'host-b:agent-a',
      1,
    ]);
    expect(exact.machines).toEqual([{ machine: 'host-b', status: 'asked' }]);

    const list = await whoisAll(here, { local: false, sessions, runPeer: remote });
    expect(list.sessions.map((session) => session.address)).toEqual([
      'host-a:agent-a',
      'host-a:agent-a-two',
      'host-b:agent-a',
      'host-b:agent-a-two',
    ]);

    // Unreachable: the question stays open for that machine.
    const down = await whoisFleet(here, 'host-b-agent-a', {
      local: false,
      sessions,
      runPeer: async () => ({
        code: 255,
        stdout: '',
        stderr: '',
        transportFailed: true,
        delivery: 'unknown',
        failureDetail: 'connection timed out',
      }),
    });
    expect(down.found).toBe('none');
    expect(down.machines).toEqual([
      { machine: 'host-a', status: 'asked' },
      { machine: 'host-b', status: 'unavailable', error: 'connection timed out' },
    ]);
    expect(answerLines(down, 0)).toEqual([
      "'host-b-agent-a' is not a ccmux session",
      'NOT asked: host-b — connection timed out',
    ]);
    // An answer about another machine's sessions is not the asked machine's answer.
    const wrong = await whoisFleet(here, 'agent-a-two', {
      local: false,
      sessions,
      runPeer: peer((argv) => whoisFleet(m, argv.at(-1) as string, { local: true, sessions })),
    });
    expect(wrong.machines[1]).toEqual({
      machine: 'host-b',
      status: 'unavailable',
      error: 'the answer came from a different machine than the one asked',
    });
    expect(wrong.session?.address).toBe('host-a:agent-a-two');
  });
});

/** Wait for a state the stream must reach, with its own bound. */
async function until(what: string, reached: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await Bun.sleep(10);
  }
}

test('the stream opens with every session and then says only what changed about one', async () => {
  await fleet(async ({ m, sessions, api, write, root }) => {
    let registry: Session[] = sessions;
    const events: WhoisEvent[] = [];
    const stop = followIdentities(m, (event) => events.push(event), {
      recheckMs: 20,
      sessions: () => registry,
    });
    try {
      await until('both sessions announced', () => events.length === 2);
      expect(events.map((event) => event.event === 'session' && event.session.address)).toEqual([
        'host-a:agent-a',
        'host-a:agent-a-two',
      ]);

      // The session talks: its activity moves, its identity does not. Several re-reads pass and
      // nothing is said.
      write(NOW, [
        ...conversation(NOW, 'host-a-agent-a', api, [
          ['and the kestrel', '2026-09-02T10:00:00.000Z'],
          ['and more', '2026-09-02T11:00:00.000Z'],
        ]),
      ]);
      await Bun.sleep(150);
      expect(events.length).toBe(2);
      // A `/clear`: the same session under a new id, in a file that opens with its title.
      const CLEARED = '66666666-6666-4666-8666-666666666666';
      write(
        CLEARED,
        conversation(CLEARED, 'host-a-agent-a', api, [['afresh', '2026-09-04T10:00:00.000Z']]),
      );
      registry = [{ ...(sessions[0] as Session), uuid: CLEARED }, sessions[1] as Session];
      await until('the new id announced', () => events.length === 3);
      const moved = events[2];
      expect(moved?.event === 'session' && moved.session.conversation).toBe(CLEARED);
      expect(
        moved?.event === 'session' && moved.session.conversations.map((life) => life.id),
      ).toEqual([BEFORE, NOW, CLEARED]);
      // What was written before the new id is in the same line, not a line of its own.
      expect(moved?.event === 'session' && moved.session.conversations[1]?.lastAt).toBe(
        '2026-09-02T11:00:00.000Z',
      );

      // The checkout moved.
      const elsewhere = join(root, 'work', 'api-moved');
      mkdirSync(elsewhere, { recursive: true });
      registry = [registry[0] as Session, { ...(sessions[1] as Session), dir: elsewhere }];
      await until('the new directory announced', () => events.length === 4);
      const redirected = events[3];
      expect(
        redirected?.event === 'session' && [
          redirected.session.address,
          redirected.session.dir,
          redirected.session.repository,
        ],
      ).toEqual(['host-a:agent-a-two', elsewhere, null]);

      registry = [registry[0] as Session];
      await until('the removal announced', () => events.length === 5);
      expect(events[4]).toEqual({
        event: 'gone',
        address: 'host-a:agent-a-two',
        machine: 'host-a',
        name: 'agent-a-two',
      });
      // Several re-reads later nothing has been said twice.
      await Bun.sleep(100);
      expect(events.length).toBe(5);
    } finally {
      stop();
    }
  });
});

test('a registry change is heard from the file, not only from the slow re-read', async () => {
  await fleet(async ({ m, sessions }) => {
    let registry: Session[] = [sessions[0] as Session];
    const events: WhoisEvent[] = [];
    // A re-read that never comes within the test: only the watcher can deliver the change.
    const stop = followIdentities(m, (event) => events.push(event), {
      recheckMs: 3_600_000,
      sessions: () => registry,
    });
    try {
      await until('the session announced', () => events.length === 1);
      registry = sessions;
      writeFileSync(join(m.stateDir, 'sessions.jsonl'), 'changed\n');
      await until('the new session announced', () => events.length === 2);
      expect(events[1]?.event === 'session' && events[1].session.address).toBe(
        'host-a:agent-a-two',
      );
    } finally {
      stop();
    }
  });
});

test('everything the user wrote, with the session and repository it was written in', async () => {
  await fleet(async ({ m, sessions, api }) => {
    const said = await searchFleet(
      m,
      parseSearch(['--since', '2026-01-01', '--role', 'user', '--json', '--full', '--local']),
      undefined,
      sessions,
    );
    expect(CorpusSearchJsonSchema.parse(said)).toEqual(said);
    expect(said.query.full).toBe(true);
    const row = (text: string) => {
      const match = said.matches.find((candidate) => candidate.text === text);
      return [match?.session, match?.ofSession, match?.repository, match?.dir];
    };
    // What the session reads now, and what it wrote before its `/clear`.
    expect(row('and the kestrel')).toEqual(['agent-a', 'agent-a', 'acme/api', api]);
    expect(row('the heron plan')).toEqual([null, 'agent-a', 'acme/api', api]);
    // Nobody's: started by hand, and left by a session that is gone.
    expect(row('by hand')).toEqual([null, null, 'acme/api', api]);
    expect(row('old work')).toEqual([null, null, 'acme/api', api]);
    expect(said.conversations.find((entry) => entry.threadId === BEFORE)).toMatchObject({
      ofSession: 'agent-a',
      repository: 'acme/api',
    });

    // Without --full the text stays where it was: an excerpt, and no second copy.
    const outline = await searchFleet(
      m,
      parseSearch(['--since', '2026-01-01', '--role', 'user', '--json', '--local']),
      undefined,
      sessions,
    );
    expect(outline.matches.map((match) => match.text)).toEqual(outline.matches.map(() => null));
    expect(() => parseSearch(['--since', '1d', '--full'])).toThrow('--full is each message');
  });
});

test('the published schemas describe the answers this build gives', async () => {
  await fleet(async ({ m, sessions }) => {
    const schemas = whoisSchemas();
    expect(Object.keys(schemas)).toEqual(['answer', 'list', 'event']);
    const answer = z.fromJSONSchema(schemas.answer as never);
    expect(
      answer.safeParse(await whoisFleet(m, 'agent-a', { local: true, sessions })).success,
    ).toBe(true);
    expect(answer.safeParse({ query: 'agent-a', found: 'nearest' }).success).toBe(false);
    const list = z.fromJSONSchema(schemas.list as never);
    expect(list.safeParse(await whoisAll(m, { local: true, sessions })).success).toBe(true);
  });
});
