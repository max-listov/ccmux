import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { histFile } from '../src/agent/claude/resume.ts';
import { formatChatInjection } from '../src/chat/format.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { appendMessage } from '../src/chat/ledger.ts';
import { SentListSchema } from '../src/chat/sentLetterSchema.ts';
import { COMMAND_SCHEMAS } from '../src/commands/answerSchemas.ts';
import { parseSearch, receiptLines } from '../src/commands/search.ts';
import { answerLines } from '../src/commands/whois.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { mergeReceipts } from '../src/context/corpusSearch.ts';
import { CorpusSearchJsonSchema, RECEIPT_MARKS_MAX } from '../src/context/corpusSearchSchema.ts';
import { searchMachine } from '../src/context/corpusShards.ts';
import { readExactMessage } from '../src/context/exactMessage.ts';
import { searchFleet } from '../src/context/searchFleet.ts';
import {
  collectSearch,
  type SearchFrame,
  SearchFrameSchema,
  SearchStreamCutError,
} from '../src/context/searchFrames.ts';
import { readSearchJournal } from '../src/context/searchJournal.ts';
import { storedConversations } from '../src/context/storedConversations.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { ControlSnapshotSchema } from '../src/control/schema/core.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { chatLogAnswer } from '../src/fleet/chatLog.ts';
import { fleetAnswer } from '../src/fleet/fleetList.ts';
import { FleetAnswerSchema } from '../src/fleet/fleetSchema.ts';
import { PackedSchema, pack, parseKnown, unpack } from '../src/fleet/peerDelta.ts';
import { peerIdentitiesAnswer } from '../src/fleet/peerRead.ts';
import { sessionIdentities } from '../src/session/identity.ts';
import {
  type SessionIdentity,
  SessionIdentitySchema,
  WhoisAnswerSchema,
  type WhoisEvent,
  WhoisEventSchema,
} from '../src/session/identitySchema.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/session/registry.ts';
import { projectOf, repositoryKey, repositoryOf } from '../src/session/repository.ts';
import { sentKeysOf } from '../src/session/sentKeys.ts';
import { readQuestion } from '../src/session/whois.ts';
import { followIdentities, whoisAll, whoisFleet } from '../src/session/whoisFleet.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeChatMessage, makeMachine, makeSession } from './helpers.ts';

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

/** What is said of sessions; a machine's own line is the subject of its own test. */
const sessionsOnly = (events: WhoisEvent[]) => (event: WhoisEvent) => {
  if (event.event !== 'machine') events.push(event);
};

test('the stream opens with every session and then says only what changed about one', async () => {
  await fleet(async ({ m, sessions, api, write, root }) => {
    let registry: Session[] = sessions;
    const events: WhoisEvent[] = [];
    const stop = followIdentities(m, sessionsOnly(events), {
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
    const stop = followIdentities(m, sessionsOnly(events), {
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
    const schemas = COMMAND_SCHEMAS.whois();
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

const passport = (dir: string, text: string): void =>
  writeFileSync(join(dir, '.passport.json'), text);
const declares = (project: unknown): string => L({ schemaVersion: 1, identity: { project } });

test('a project is what the checkout declares, never what a name suggests', async () => {
  await fleet(async ({ m, sessions, api, root }) => {
    const core = join(api, 'packages', 'core');
    const plain = join(root, 'work', 'plain');
    mkdirSync(core, { recursive: true });
    mkdirSync(plain, { recursive: true });
    const registry = [
      sessions[0] as Session,
      makeSession({ name: 'agent-core', uuid: OTHER, dir: core }),
      makeSession({ name: 'agent-plain', uuid: FOREIGN, dir: plain }),
    ];
    const identities = async () => {
      const all = await sessionIdentities(m, registry);
      for (const identity of all) expect(SessionIdentitySchema.parse(identity)).toEqual(identity);
      return all;
    };
    const projects = async () => (await identities()).map((identity) => identity.project);
    // A declaration above the checkout is some other repository's, and a directory that is no
    // checkout has none: the field is absent, not null and not the directory's name.
    passport(join(root, 'work'), declares('umbrella'));
    expect((await identities()).map((identity) => 'project' in identity)).toEqual([
      false,
      false,
      false,
    ]);
    expect(await projectOf(join(api, 'no-such-directory'))).toBeNull();

    // The root of the checkout declares it, for every directory inside.
    passport(api, declares('atlas'));
    expect(await projects()).toEqual(['atlas', 'atlas', undefined]);
    expect((await identities())[0]).toMatchObject({ repository: 'acme/api', project: 'atlas' });

    // A declaration that names no project names none.
    for (const text of [declares(''), declares(7), L({ identity: {} }), L([]), '{ not json']) {
      passport(api, text);
      expect(await projects()).toEqual([undefined, undefined, undefined]);
    }
    // And one that was rewritten is read again.
    passport(api, declares('borealis'));
    expect(await projects()).toEqual(['borealis', 'borealis', undefined]);

    const ask = (query: string) => whoisFleet(m, query, { local: true, sessions: registry });
    const answer = await ask('host-a:agent-core');
    expect(WhoisAnswerSchema.parse(answer)).toEqual(answer);
    expect(answer.session?.project).toBe('borealis');
    expect(answerLines(answer, Date.now())).toContain('  project       borealis');
    expect(answerLines(await ask('host-a:agent-plain'), Date.now())).toContain('  project       -');
    // A conversation no session reads is in a directory too.
    expect((await ask(REMOVED)).conversation).toMatchObject({ dir: api, project: 'borealis' });
  });
});

test('the stream says a session again when its repository declares another project', async () => {
  await fleet(async ({ m, sessions, api }) => {
    const events: WhoisEvent[] = [];
    const stop = followIdentities(m, sessionsOnly(events), {
      recheckMs: 20,
      sessions: () => [sessions[0] as Session],
    });
    try {
      await until('the session announced', () => events.length === 1);
      expect(events[0]?.event === 'session' && 'project' in events[0].session).toBe(false);
      passport(api, declares('atlas'));
      await until('the project announced', () => events.length === 2);
      expect(events[1]?.event === 'session' && events[1].session.project).toBe('atlas');
      await Bun.sleep(100);
      expect(events.length).toBe(2);
    } finally {
      stop();
    }
  });
});

test('what the user wrote carries the project, and --project finds it by that name', async () => {
  await fleet(async ({ m, sessions, api }) => {
    const search = (...args: string[]) =>
      searchFleet(
        m,
        parseSearch(['--since', '2026-01-01', '--role', 'user', '--json', '--full', ...args]),
        undefined,
        sessions,
      );
    const bare = await search('--local');
    expect(CorpusSearchJsonSchema.parse(bare)).toEqual(bare);
    expect(bare.matches.length).toBe(5);
    expect(bare.matches.some((match) => 'project' in match)).toBe(false);
    expect(bare.conversations.some((entry) => 'project' in entry)).toBe(false);
    // Neither the directory nor a session is called this: only the declaration is.
    expect((await search('--local', '--project', 'atlas')).total).toBe(0);

    passport(api, declares('atlas'));
    const said = await search('--local');
    expect(CorpusSearchJsonSchema.parse(said)).toEqual(said);
    expect(said.matches.map((match) => [match.repository, match.project])).toEqual(
      said.matches.map(() => ['acme/api', 'atlas']),
    );
    expect(said.conversations.map((entry) => [entry.project, entry.sample.project])).toEqual(
      said.conversations.map(() => ['atlas', 'atlas']),
    );
    expect((await search('--local', '--project', 'ATLAS')).total).toBe(5);
    expect((await search('--local', '--project', 'borealis')).total).toBe(0);
  });
});

test('both published schemas describe the project as a field that may be absent', () => {
  const field = {
    type: 'string',
    minLength: 1,
    description: expect.stringContaining('identity.project'),
  };
  const shape = (schema: unknown) => schema as { properties: never; required: string[] };
  const answer = shape(COMMAND_SCHEMAS.whois().answer);
  const session = shape(
    (answer.properties as { session: { anyOf: unknown[] } }).session.anyOf.find(
      (option) => (option as { type: string }).type === 'object',
    ),
  );
  expect((session.properties as { project: object }).project).toMatchObject(field);
  expect(session.required).toContain('repository');
  expect(session.required).not.toContain('project');
  const search = shape(z.toJSONSchema(CorpusSearchJsonSchema));
  const match = shape((search.properties as { matches: { items: unknown } }).matches.items);
  expect((match.properties as { project: object }).project).toMatchObject(field);
  expect(match.required).not.toContain('project');
  const talk = shape(
    (search.properties as { conversations: { items: unknown } }).conversations.items,
  );
  expect((talk.properties as { project: object }).project).toMatchObject(field);
});

test('a source that says nothing is named by the working half beside it', async () => {
  await fleet(async ({ m, sessions, api, root }) => {
    // `api` is the public source: its own declaration names the repository and no project.
    const work = join(root, 'work');
    const half = join(work, 'api-dev');
    const other = join(work, 'billing-dev');
    mkdirSync(half, { recursive: true });
    mkdirSync(other, { recursive: true });
    const project = async () => (await sessionIdentities(m, sessions))[0]?.project;
    const halfDeclares = (source: string, name: unknown) =>
      passport(half, L({ identity: { project: name }, source: { repositoryId: source } }));

    // A neighbour by name only is not a half of anything.
    expect(await project()).toBeUndefined();
    // Nor is one that is the working half of some other repository.
    halfDeclares('acme/billing', 'atlas');
    expect(await project()).toBeUndefined();
    // The half that names this repository speaks for it — a declaration that appeared inside a
    // directory which was already there, with the origin as the repository's name.
    halfDeclares('Acme/API', 'atlas');
    expect(await project()).toBe('atlas');
    expect((await sessionIdentities(m, sessions))[0]).toMatchObject({
      repository: 'acme/api',
      project: 'atlas',
    });
    // The repository the source's own declaration names wins over its origin.
    passport(api, L({ identity: { repositoryId: 'acme/renamed' } }));
    expect(await project()).toBeUndefined();
    halfDeclares('acme/renamed', 'atlas');
    expect(await project()).toBe('atlas');
    // What the source says of itself outranks what a neighbour says of it.
    passport(api, L({ identity: { repositoryId: 'acme/renamed', project: 'borealis' } }));
    expect(await project()).toBe('borealis');
    passport(api, L({ identity: { repositoryId: 'acme/renamed' } }));
    // A key the passport format refuses names nothing.
    for (const refused of ['acme/atlas', 'x'.repeat(201), '']) {
      halfDeclares('acme/renamed', refused);
      expect(await project()).toBeUndefined();
    }
    // Two halves naming different projects: neither is chosen. The same project twice is one.
    halfDeclares('acme/renamed', 'atlas');
    passport(
      other,
      L({ identity: { project: 'borealis' }, source: { repositoryId: 'acme/renamed' } }),
    );
    expect(await project()).toBeUndefined();
    passport(
      other,
      L({ identity: { project: 'atlas' }, source: { repositoryId: 'acme/renamed' } }),
    );
    expect(await project()).toBe('atlas');

    // A session opened on the folder the halves sit in belongs to what both of them resolve to;
    // a folder is not a checkout, so it has no repository.
    const onFolder = async () =>
      (await sessionIdentities(m, [makeSession({ name: 'agent-f', uuid: FOREIGN, dir: work })]))[0];
    rmSync(other, { recursive: true });
    expect(await onFolder()).toMatchObject({ repository: null, project: 'atlas' });
    expect(Bun.spawnSync(['git', 'init', '-q', half]).exitCode).toBe(0);
    expect((await onFolder())?.project).toBe('atlas');
    // One checkout in the folder that belongs elsewhere, or nowhere, and the folder is nobody's.
    const stranger = join(work, 'stranger');
    expect(Bun.spawnSync(['git', 'init', '-q', stranger]).exitCode).toBe(0);
    expect((await onFolder())?.project).toBeUndefined();
    passport(stranger, declares('borealis'));
    expect((await onFolder())?.project).toBeUndefined();
    passport(stranger, declares('atlas'));
    expect((await onFolder())?.project).toBe('atlas');
    rmSync(stranger, { recursive: true });

    // The project's checkouts on the machine, for the session in one of them and for the one on
    // the folder: the source it sits in, and the working half that speaks for it.
    const inSource = (await sessionIdentities(m, sessions))[0];
    expect(inSource?.checkouts).toEqual([
      { dir: api, repository: 'acme/renamed', role: 'source', current: true },
      { dir: half, repository: null, role: 'private-workspace', current: false },
    ]);
    expect((await onFolder())?.checkouts?.map((row) => [row.dir, row.current])).toEqual([
      [api, false],
      [half, false],
    ]);
    // A role the declaration names is the role; a checkout of another project is not listed.
    passport(
      half,
      L({
        identity: { project: 'atlas', role: 'product-companion' },
        source: { repositoryId: 'acme/renamed' },
      }),
    );
    expect(Bun.spawnSync(['git', 'init', '-q', stranger]).exitCode).toBe(0);
    passport(stranger, declares('borealis'));
    expect(
      (await sessionIdentities(m, sessions))[0]?.checkouts?.map((row) => [row.dir, row.role]),
    ).toEqual([
      [api, 'source'],
      [half, 'product-companion'],
    ]);
    rmSync(stranger, { recursive: true });
    // Nothing declared, nothing listed.
    expect(
      'checkouts' in
        ((
          await sessionIdentities(m, [makeSession({ name: 'agent-p', uuid: FOREIGN, dir: root })])
        )[0] ?? {}),
    ).toBe(false);

    // And the same answer for what was said there.
    const said = await searchFleet(
      m,
      parseSearch(['--since', '2026-01-01', '--role', 'user', '--json', '--local']),
      undefined,
      sessions,
    );
    expect(new Set(said.matches.map((match) => match.project))).toEqual(new Set(['atlas']));
  });
});

test('a remote added to a checkout is seen without starting again', async () => {
  await fleet(async ({ root }) => {
    const fresh = join(root, 'work', 'fresh');
    mkdirSync(fresh, { recursive: true });
    expect(await repositoryOf(fresh)).toBeNull();
    expect(Bun.spawnSync(['git', 'init', '-q', fresh]).exitCode).toBe(0);
    expect(await repositoryOf(fresh)).toBeNull();
    const add = ['git', '-C', fresh, 'remote', 'add', 'origin', 'git@example.com:acme/fresh.git'];
    expect(Bun.spawnSync(add).exitCode).toBe(0);
    expect(await repositoryOf(join(fresh))).toBe('acme/fresh');
    // A worktree's root holds a `.git` file, and is a checkout of the same repository.
    const tree = join(root, 'work', 'fresh-tree');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    expect(
      Bun.spawnSync(['git', '-C', fresh, 'commit', '-q', '--allow-empty', '-m', 'first'], { env })
        .exitCode,
    ).toBe(0);
    expect(Bun.spawnSync(['git', '-C', fresh, 'worktree', 'add', '-q', tree]).exitCode).toBe(0);
    expect(await repositoryOf(tree)).toBe('acme/fresh');
    // Its remotes are the repository's: a change there is seen from the worktree too.
    const moved = [
      'git',
      '-C',
      fresh,
      'remote',
      'set-url',
      'origin',
      'git@example.com:acme/moved.git',
    ];
    expect(Bun.spawnSync(moved).exitCode).toBe(0);
    expect(await repositoryOf(tree)).toBe('acme/moved');
  });
});

const MARK = 'ticket ([a-z0-9]{8})\\s*$';
/** A user message as the provider writes it, under an id the test chooses. */
const said = (uuid: string, sessionId: string, cwd: string, text: string, at: string): string =>
  L({
    type: 'user',
    uuid,
    sessionId,
    timestamp: at,
    cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

test('a marked message is answered with every place it arrived, and when it first did', async () => {
  await fleet(async ({ m, sessions, api, write }) => {
    passport(api, declares('atlas'));
    // agent-a reads NOW. One paste carries two marks and text after the first; a later message
    // repeats a mark; the same mark was also pasted to agent-a-two.
    write(NOW, [
      L({ type: 'custom-title', customTitle: 'host-a-agent-a', sessionId: NOW }),
      said(
        'm-1',
        NOW,
        api,
        'fix this\n\nticket aaaa1111\nand that\n\n[1-3] ticket bbbb2222',
        '2026-09-02T10:00:00.000Z',
      ),
      said('m-2', NOW, api, 'again\n\nticket aaaa1111', '2026-09-02T12:00:00.000Z'),
      said(
        'm-3',
        NOW,
        api,
        'the mark ticket cccc3333 in the middle of a line',
        '2026-09-02T13:00:00.000Z',
      ),
    ]);
    write(OTHER, [
      L({ type: 'custom-title', customTitle: 'host-a-agent-a-two', sessionId: OTHER }),
      said('o-1', OTHER, api, 'same one\n\nticket aaaa1111', '2026-09-02T11:00:00.000Z'),
    ]);
    // A continuation of agent-a's conversation: the earlier message copied under its own id.
    write(BEFORE, [
      L({ type: 'custom-title', customTitle: 'host-a-agent-a', sessionId: BEFORE }),
      said(
        'm-1',
        BEFORE,
        api,
        'fix this\n\nticket aaaa1111\nand that\n\n[1-3] ticket bbbb2222',
        '2026-09-02T10:00:00.000Z',
      ),
    ]);
    const search = (...args: string[]) =>
      searchFleet(
        m,
        parseSearch([MARK, '--role', 'user', '--local', ...args]),
        undefined,
        sessions,
      );
    const answer = await search('--receipts', '--json', '--limit', '1');
    expect(CorpusSearchJsonSchema.parse(answer)).toEqual(answer);
    expect(answer.query.receipts).toBe(true);
    // --limit trims the lines, not the receipts.
    expect(answer.matches.length).toBe(1);
    const places = answer.receipts?.marks.map(({ mark, deliveries }) => [
      mark,
      ...deliveries.map((row) => [row.ofSession, row.session, row.receivedAt, row.messageId]),
    ]);
    expect(places).toEqual([
      // The first message that carries it, not the repeat; the copy is the same delivery, kept
      // where the session reads now; the other session's is a second place.
      [
        'aaaa1111',
        ['agent-a', 'agent-a', '2026-09-02T10:00:00.000Z', 'm-1:0'],
        ['agent-a-two', 'agent-a-two', '2026-09-02T11:00:00.000Z', 'o-1:0'],
      ],
      ['bbbb2222', ['agent-a', 'agent-a', '2026-09-02T10:00:00.000Z', 'm-1:0']],
    ]);
    expect(answer.receipts?.marks[0]?.deliveries[0]).toMatchObject({
      machine: 'host-a',
      repository: 'acme/api',
      project: 'atlas',
      dir: api,
      role: 'user',
      lines: true,
    });
    expect(answer.receipts?.truncated).toBe(false);
    // Read by several processes, the answer is the one a single process gives: the copy and the
    // conversation it was copied from land in different shares.
    const stored = storedConversations(m, sessions);
    const dealt = await searchMachine(
      'host-a',
      parseSearch([MARK, '--role', 'user', '--receipts']).query,
      stored,
      3,
    );
    const alone = await searchMachine(
      'host-a',
      parseSearch([MARK, '--role', 'user', '--receipts']).query,
      stored,
      1,
    );
    expect(dealt.receipts).toEqual(alone.receipts as never);
    expect(dealt.receipts?.marks.map((entry) => entry.deliveries.length)).toEqual([2, 1]);
    // A pattern without a group is its own mark; without the mode there are no receipts at all.
    const whole = await searchFleet(
      m,
      parseSearch(['ticket cccc3333', '--role', 'user', '--local', '--receipts']),
      undefined,
      sessions,
    );
    expect(whole.receipts?.marks.map((entry) => entry.mark)).toEqual(['ticket cccc3333']);
    expect('receipts' in (await search('--json'))).toBe(false);
    const lines = receiptLines(answer, Date.parse('2026-09-02T12:00:00.000Z'));
    expect(lines.filter((line) => /^(aaaa1111|bbbb2222|\s+\S)/.test(line)).length).toBe(3);
    expect(lines).toContain('2 mark(s), 3 place(s)');
    expect(() => parseSearch(['--since', '1d', '--receipts'])).toThrow('--receipts is where');
    expect(() => parseSearch([MARK, '--map', '--receipts'])).toThrow('--receipts is where');
  });
});

test('a delivery says who sent the marked message: a person, a letter that quotes it, the harness', async () => {
  await fleet(async ({ m, sessions, api, write }) => {
    const letter = makeChatMessage({ body: 'take the task\n\nticket dddd4444' });
    appendMessage(m, letter);
    const forged = makeChatMessage({ body: 'also this\n\nticket ffff6666' });
    write(NOW, [
      L({ type: 'custom-title', customTitle: 'host-a-agent-a', sessionId: NOW }),
      said('p-1', NOW, api, 'do this\n\nticket eeee5555', '2026-09-02T10:00:00.000Z'),
      // The same mark, quoted to another session in a letter ccmux delivered there.
      said('l-1', NOW, api, formatChatInjection(letter), '2026-09-02T11:00:00.000Z'),
      // A letter this machine's ledger does not hold is nobody's letter and no person's paste.
      said(
        'f-1',
        NOW,
        api,
        formatChatInjection(forged).replace(
          `· id: ${forged.id}`,
          '· id: 99999999-9999-4999-8999-999999999999',
        ),
        '2026-09-02T12:00:00.000Z',
      ),
      said(
        'h-1',
        NOW,
        api,
        '<task-notification>\n<task-id>b1</task-id>\nticket abab7777',
        '2026-09-02T13:00:00.000Z',
      ),
    ]);
    const answer = await searchFleet(
      m,
      parseSearch([MARK, '--kind', 'message', '--local', '--receipts', '--json']),
      undefined,
      sessions,
    );
    expect(CorpusSearchJsonSchema.parse(answer)).toEqual(answer);
    const verdicts = Object.fromEntries(
      (answer.receipts?.marks ?? []).map(({ mark, deliveries }) => [
        mark,
        deliveries.map((row) => row.sender?.verdict),
      ]),
    );
    expect(verdicts).toEqual({
      eeee5555: ['person'],
      dddd4444: ['session-letter'],
      ffff6666: ['unverifiable'],
      abab7777: ['harness'],
    });
    // A reader with none of the machine's records does not say, rather than guess a person.
    const blind = await searchMachine(
      'host-a',
      parseSearch([MARK, '--kind', 'message', '--receipts']).query,
      storedConversations(m, sessions),
      1,
    );
    expect(blind.receipts?.marks.every((entry) => !('sender' in (entry.deliveries[0] ?? {})))).toBe(
      true,
    );
  });
});

test('receipts are bounded, say so, and merge across machines that may not know them', async () => {
  await fleet(async ({ m, sessions, api, write }) => {
    const many = Array.from(
      { length: RECEIPT_MARKS_MAX + 5 },
      (_, i) => `k${String(i).padStart(6, '0')}`,
    );
    write(NOW, [
      L({ type: 'custom-title', customTitle: 'host-a-agent-a', sessionId: NOW }),
      said('m-1', NOW, api, many.join(' '), '2026-09-02T10:00:00.000Z'),
    ]);
    const opts = parseSearch(['k(\\d{6})', '--role', 'user', '--receipts', '--json', '--local']);
    const bounded = await searchFleet(m, opts, undefined, sessions);
    expect([bounded.receipts?.marks.length, bounded.receipts?.truncated]).toEqual([
      RECEIPT_MARKS_MAX,
      true,
    ]);

    // Another machine's answer joins; one that predates the mode has no receipts and is still read.
    const fleetOf = { ...m, fleet: { 'host-b': 'b.example', 'host-c': 'c.example' } };
    const one = parseSearch(['k(000001)', '--role', 'user', '--receipts', '--json']);
    const here = await searchFleet(
      m,
      parseSearch(['k(000001)', '--role', 'user', '--receipts', '--json', '--local']),
      undefined,
      sessions,
    );
    const from = (machine: string, receipts: boolean) => {
      const moved = JSON.parse(JSON.stringify(here).replaceAll('host-a', machine)) as typeof here;
      if (!receipts) {
        delete moved.receipts;
        delete moved.query.receipts;
      }
      return JSON.stringify(moved);
    };
    const asked: string[][] = [];
    const answer = await searchFleet(
      fleetOf,
      one,
      async (_m, machine, _alias, argv) => {
        asked.push(argv);
        return {
          code: 0,
          stdout: from(machine, machine === 'host-b'),
          stderr: '',
          transportFailed: false,
          delivery: 'received' as const,
        };
      },
      sessions,
    );
    expect(asked.every((argv) => argv.includes('--receipts'))).toBe(true);
    expect(answer.machines.map((row) => row.status)).toEqual(['searched', 'searched', 'searched']);
    expect(
      answer.receipts?.marks.map((entry) => entry.deliveries.map((row) => row.machine)),
    ).toEqual([['host-a', 'host-b']]);
  });
});

test('the stream follows every machine, and one that stops answering loses no session', async () => {
  await fleet(async ({ m, sessions }) => {
    const fleetOf = { ...m, fleet: { 'host-b': 'b.example' } };
    const there = async (name: string, dir: string) =>
      (
        await sessionIdentities({ ...m, rcPrefix: 'host-b' }, [
          makeSession({ name, uuid: FOREIGN, dir }),
        ])
      )[0] as SessionIdentity;
    // The other machine has a session of the same NAME as one here, and one of its own.
    let remote: SessionIdentity[] | null = [
      await there('agent-a', '/srv/api'),
      await there('agent-b', '/srv/api'),
    ];
    const asked: string[][] = [];
    const events: WhoisEvent[] = [];
    const stop = followIdentities(fleetOf, (event) => events.push(event), {
      recheckMs: 20,
      peerEveryMs: 20,
      sessions: () => [sessions[0] as Session],
      runPeer: async (_m, machine, _alias, argv) => {
        asked.push(argv);
        const known = parseKnown(argv[argv.indexOf('--known') + 1]);
        return {
          code: remote === null ? 255 : 0,
          stdout:
            remote === null
              ? ''
              : L({
                  machine,
                  sessions: pack(remote, argv.includes('--known') ? known : new Set()),
                }),
          stderr: '',
          transportFailed: remote === null,
          delivery: remote === null ? ('unknown' as const) : ('received' as const),
          ...(remote === null ? { failureDetail: 'no route' } : {}),
        };
      },
    });
    const said = () =>
      events.map((event) =>
        event.event === 'session'
          ? `session ${event.session.address}`
          : event.event === 'gone'
            ? `gone ${event.address}`
            : `machine ${event.machine} ${event.status}`,
      );
    try {
      await until(
        'both machines read',
        () => said().filter((line) => line.startsWith('machine')).length === 2,
      );
      for (const event of events) expect(WhoisEventSchema.parse(event)).toEqual(event);
      expect(said().sort()).toEqual([
        'machine host-a asked',
        'machine host-b asked',
        'session host-a:agent-a',
        'session host-b:agent-a',
        'session host-b:agent-b',
      ]);
      // A machine's line comes after its sessions: it says they have been read.
      expect(said().indexOf('machine host-b asked')).toBeGreaterThan(
        said().indexOf('session host-b:agent-b'),
      );
      // Asked by change, of the daemon: the second question names what is already held.
      await until('asked again', () => asked.length >= 3);
      expect(asked[0]?.slice(0, 3)).toEqual(['ccmux', '_peer-read', 'identities']);
      expect(asked.at(-1)).toContain('--known');
      expect(events.length).toBe(5);

      // The other machine's session moves; this machine's session of the same name does not.
      remote = [await there('agent-a', '/srv/moved'), remote[1] as SessionIdentity];
      await until('the move announced', () => events.length === 6);
      const moved = events[5];
      expect(moved?.event === 'session' && [moved.session.address, moved.session.dir]).toEqual([
        'host-b:agent-a',
        '/srv/moved',
      ]);

      // It stops answering: said once, with the reason, and none of its sessions is called gone.
      const whenUp = remote;
      remote = null;
      await until('the silence announced', () => events.length === 7);
      expect(events[6]).toEqual({
        event: 'machine',
        machine: 'host-b',
        status: 'unavailable',
        error: 'no route',
      });
      await Bun.sleep(120);
      expect(events.length).toBe(7);

      // It answers again without one session: that one is gone, and the machine is read again.
      remote = [whenUp[0] as SessionIdentity];
      await until('the return announced', () => events.length === 9);
      expect(said().slice(7)).toEqual(['gone host-b:agent-b', 'machine host-b asked']);
    } finally {
      stop();
    }

    // Asked for this machine only, nobody else is asked.
    const before = asked.length;
    const alone: WhoisEvent[] = [];
    const stopLocal = followIdentities(fleetOf, (event) => alone.push(event), {
      local: true,
      recheckMs: 20,
      peerEveryMs: 20,
      sessions: () => [sessions[0] as Session],
      runPeer: async () => {
        throw new Error('a local follower asked another machine');
      },
    });
    try {
      await until('this machine read', () => alone.length === 2);
      await Bun.sleep(80);
      expect(alone.map((event) => event.event)).toEqual(['session', 'machine']);
      expect(asked.length).toBe(before);
    } finally {
      stopLocal();
    }
  });
});

test('a machine answers another about its sessions by change', async () => {
  await fleet(async ({ m, sessions }) => {
    writeFileSync(sessionsPath(m), sessions.map((session) => `${L(session)}\n`).join(''));
    const Answer = z.object({ machine: z.string(), sessions: PackedSchema });
    const first = Answer.parse(await peerIdentitiesAnswer(m, []));
    expect(first.machine).toBe('host-a');
    const rows = z.array(SessionIdentitySchema).parse(unpack(first.sessions, {}));
    expect(rows.map((row) => row.address)).toEqual(['host-a:agent-a', 'host-a:agent-a-two']);
    // Asked again by a reader that holds them, it sends the names of the rows and no row.
    const again = Answer.parse(await peerIdentitiesAnswer(m, first.sessions.refs));
    expect([again.sessions.refs, again.sessions.items]).toEqual([first.sessions.refs, {}]);
  });
});

test('only a continued Claude session carries copies: a Codex line number is not a message', () => {
  const at = (provider: 'claude' | 'codex', address: string, ofSession: string | null) => ({
    address,
    provider,
    threadId: address,
    session: null,
    ofSession,
    dir: null,
    repository: null,
    lines: true,
    seq: 8,
    receivedAt: '2026-09-02T10:00:00.000Z',
    role: 'user' as const,
    messageId: '8:0',
  });
  const merged = (deliveries: ReturnType<typeof at>[]) =>
    mergeReceipts([
      { truncated: false, marks: [{ mark: 'aaaa1111', deliveries }] },
    ]).marks[0]?.deliveries.map((row) => row.address);
  // Two Codex conversations open with a paste on the same line: two places.
  expect(merged([at('codex', 'thread-1', null), at('codex', 'thread-2', null)])).toEqual([
    'thread-1',
    'thread-2',
  ]);
  expect(merged([at('codex', 'thread-1', 'agent-a'), at('codex', 'thread-2', 'agent-a')])).toEqual([
    'thread-1',
    'thread-2',
  ]);
  // Two conversations nobody owns are two, whatever their ids; one session's copy is one.
  expect(merged([at('claude', 'c-1', null), at('claude', 'c-2', null)])).toEqual(['c-1', 'c-2']);
  expect(merged([at('claude', 'c-1', 'agent-a'), at('claude', 'c-2', 'agent-b')])).toEqual([
    'c-1',
    'c-2',
  ]);
  expect(merged([at('claude', 'c-1', 'agent-a'), at('claude', 'c-2', 'agent-a')])).toEqual(['c-1']);
});

/** The answers with the times a read takes left out: two reads of one store differ in nothing else. */
const timeless = <T extends { machines: readonly object[] }>(answer: T): T => ({
  ...answer,
  machines: answer.machines.map((row) => ('elapsedMs' in row ? { ...row, elapsedMs: 0 } : row)),
});

test('a program asks the daemon by name and gets the object the command prints', async () => {
  await fleet(async ({ root, m: fixture, sessions, api, write }) => {
    // Every store named: the search runs as a process that reads the machine's file, and a store
    // that file leaves out is the operator's own.
    const m: MachineConfig = {
      ...fixture,
      codexHome: join(root, 'codex'),
      codexSessionsDir: join(root, 'codex', 'sessions'),
      // No session of this fixture runs: a multiplexer that lists nothing says exactly that.
      tmuxBin: '/usr/bin/true',
    };
    mkdirSync(join(root, 'codex', 'sessions'), { recursive: true });
    write(NOW, [
      L({ type: 'custom-title', customTitle: 'host-a-agent-a', sessionId: NOW }),
      said('p-1', NOW, api, 'do this\n\nticket eeee5555', '2026-09-02T10:00:00.000Z'),
    ]);
    await writeSessionsUnlocked(m, sessions);
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(m));
    // The search runs as this binary started again; it reads the machine the daemon serves.
    const before = process.env.CCMUX_CONFIG;
    process.env.CCMUX_CONFIG = config;
    const publisher = new ControlPublisher(m);
    const server = createControlServer(m, publisher);
    const client = createControlClient({ socket: controlSocket(m) });
    try {
      // Each answer is the one the command builds, by the same function.
      expect(await client['identity.whois']({ query: 'host-a-agent-a', local: true })).toEqual(
        await whoisFleet(m, 'host-a-agent-a', { local: true }),
      );
      expect(await client['identity.list']({ local: true })).toEqual(
        await whoisAll(m, { local: true }),
      );
      const request = {
        pattern: MARK,
        kinds: ['message' as const],
        receipts: true,
        machines: [],
      };
      const local = await searchFleet(
        m,
        parseSearch([MARK, '--kind', 'message', '--local', '--receipts', '--json']),
      );
      const frames: SearchFrame[] = [];
      const stream = await client.search(request);
      for await (const frame of stream) frames.push(SearchFrameSchema.parse(frame));
      expect(frames.at(-1)?.frame).toBe('end');
      const streamed = await collectSearch(frames);
      expect(CorpusSearchJsonSchema.parse(streamed)).toEqual(streamed);
      expect(timeless(streamed)).toEqual(timeless(local));
      expect(streamed.receipts?.marks[0]?.deliveries[0]?.sender?.verdict).toBe('person');
      // The search is this machine's to record, under the principal that asked it.
      const journaled = () =>
        readSearchJournal(m, 0, null).entries.map((row) => [
          row.via,
          row.mode,
          row.total,
          row.caller,
        ]);
      expect(journaled()).toEqual([
        ['control', 'receipts', streamed.total, 'ccmux/service@host-a'],
      ]);
      // A stream that stops before its last frame is not an answer, and is not read as one.
      await expect(collectSearch(frames.slice(0, -1))).rejects.toBeInstanceOf(SearchStreamCutError);
      // A caller that leaves ends the process that was reading for it.
      const searching = (): string[] =>
        Bun.spawnSync(['pgrep', '-P', String(process.pid), '-f', '_operation'])
          .stdout.toString()
          .split('\n')
          .filter((line) => line !== '');
      const leaving = new AbortController();
      const left = await client.search.withOptions(request, { signal: leaving.signal });
      const pending = left.next().then(
        () => 'answered',
        () => 'left',
      );
      const deadline = Date.now() + 5_000;
      while (searching().length === 0 && Date.now() < deadline) await Bun.sleep(5);
      leaving.abort();
      await pending;
      while (searching().length > 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(searching()).toEqual([]);
      // A search its caller left before the answer was not answered: it is not written.
      expect(journaled()).toHaveLength(1);

      // What this client and this daemon each call the contract: the same, operation by operation.
      // The daemon answers more than a client asks — its own fleet reads — so the whole digests
      // differ and every operation the client knows is compared by name.
      const identity = await client.identity();
      expect(identity.server).toBeDefined();
      for (const [operation, digest] of Object.entries(identity.client.operations))
        expect([operation, identity.server?.operations[operation]]).toEqual([operation, digest]);
      expect(Object.keys(identity.client.operations)).toEqual(
        expect.arrayContaining(['control.identity.whois', 'control-events.search']),
      );

      // A request that names no search is the caller's mistake, said before anything is started.
      await expect(
        (async () => {
          for await (const _ of await client.search({ machines: [] })) void _;
        })(),
      ).rejects.toBeDefined();

      const message = await client['message.read']({ address: 'host-a:agent-a', messageId: 'p-1' });
      expect(message).toEqual({
        ...(await readExactMessage(m, sessions[0] as Session, 'p-1')),
        observedAt: message.observedAt,
      });
      expect(message.message?.sender.verdict).toBe('person');
      await expect(
        client['message.read']({ address: 'host-b:agent-a', messageId: 'p-1' }),
      ).rejects.toBeDefined();

      // The fleet as the command prints it: this machine's sessions under its own name.
      const fleetNow = await client['fleet.list']({});
      expect(FleetAnswerSchema.parse(fleetNow)).toEqual(fleetNow);
      expect(fleetNow.machines.map((row) => [row.machine, row.alias, row.ok])).toEqual([
        ['host-a', null, true],
      ]);
      expect(fleetNow.machines[0]?.sessions.map((row) => row.name).sort()).toEqual(
        (await fleetAnswer(m)).machines[0]?.sessions.map((row) => row.name).sort() as string[],
      );
      expect(fleetNow.machines[0]?.sessions.length).toBe(sessions.length);

      // The chat log as the command builds it, a sent letter in it.
      appendMessage(m, makeChatMessage({ body: 'build is green' }));
      const logNow = await client['chat.log']({});
      expect(logNow).toEqual(await chatLogAnswer(m, { limit: 30, fleet: false }));
      expect(logNow.rows.length).toBe(1);

      const letters = await client['letter.list']({});
      expect(SentListSchema.parse(letters)).toEqual(letters);
      expect(letters.sent).toEqual([]);

      // The stream opens with every session and a line for the machine, as the command's does.
      const abort = new AbortController();
      const events: WhoisEvent[] = [];
      const follow = await client.watchIdentities.withOptions(
        { local: true },
        { signal: abort.signal },
      );
      for await (const event of follow) {
        events.push(event);
        if (event.event === 'machine') break;
      }
      abort.abort();
      expect(events.filter((event) => event.event === 'session').length).toBe(sessions.length);
      expect(events.at(-1)).toEqual({ event: 'machine', machine: 'host-a', status: 'asked' });

      // Managing a session by name: keys are typed and recorded as ccmux's, a stop says what it
      // found, a removal takes the session out of the registry and leaves its history.
      const target = managedPeer(m.rcPrefix, sessions[0] as Session);
      expect(await client['session.keys']({ target, text: '/compact' })).toEqual({
        target,
        accepted: true,
      });
      expect(sentKeysOf(m, 'agent-a').map((row) => row.by)).toEqual(['ccmux:host-a:cli']);
      expect(await client['session.stop']({ target })).toMatchObject({ accepted: true });
      expect(await client['session.remove']({ target })).toMatchObject({
        accepted: true,
        stopped: true,
      });
      expect(loadSessions(m).map((session) => session.name)).toEqual(['agent-a-two']);
      expect(existsSync(histFile(api, NOW, m.projectsDir))).toBe(true);
      await expect(client['session.stop']({ target })).rejects.toBeDefined();
    } finally {
      await client.close();
      publisher.close();
      await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
      await server.observability.close();
      if (before === undefined) delete process.env.CCMUX_CONFIG;
      else process.env.CCMUX_CONFIG = before;
    }
  });
});

test("while a search reads gigabytes, the daemon's session list answers in its own time", async () => {
  await fleet(async ({ root, m: fixture, sessions, api, write }) => {
    const m: MachineConfig = {
      ...fixture,
      codexHome: join(root, 'codex'),
      codexSessionsDir: join(root, 'codex', 'sessions'),
      tmuxBin: '/usr/bin/true',
    };
    mkdirSync(join(root, 'codex', 'sessions'), { recursive: true });
    // A conversation large enough that reading it takes the search a while: about 40 MB.
    const filler = 'x'.repeat(400);
    write(
      NOW,
      Array.from({ length: 100_000 }, (_, index) =>
        said(`p-${index}`, NOW, api, `${filler} ${index}`, '2026-09-02T10:00:00.000Z'),
      ),
    );
    await writeSessionsUnlocked(m, sessions);
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(m));
    const before = process.env.CCMUX_CONFIG;
    process.env.CCMUX_CONFIG = config;
    const publisher = new ControlPublisher(m);
    const server = createControlServer(m, publisher);
    const client = createControlClient({ socket: controlSocket(m) });
    const searching = (): boolean =>
      Bun.spawnSync(['pgrep', '-P', String(process.pid), '-f', '_operation']).stdout.length > 0;
    try {
      let ended = false;
      const search = (async () => {
        const frames: SearchFrame[] = [];
        for await (const frame of await client.search({ pattern: 'zz-never-said', machines: [] }))
          frames.push(frame);
        ended = true;
        return frames;
      })();
      const deadline = Date.now() + 10_000;
      while (!searching() && Date.now() < deadline) await Bun.sleep(5);
      expect(searching()).toBe(true);
      // The search is a process of its own; the list is read from the prepared snapshot, in the
      // daemon's loop, which the search does not hold.
      const started = performance.now();
      const listed = await client['session.list']();
      const tookMs = performance.now() - started;
      // The snapshot the daemon publishes, whole: what a monitor reads every few seconds.
      expect(ControlSnapshotSchema.parse(listed)).toEqual(listed);
      expect({ tookMs: tookMs < 1_000, searchStillRunning: !ended }).toEqual({
        tookMs: true,
        searchStillRunning: true,
      });
      expect((await search).at(-1)?.frame).toBe('end');
    } finally {
      await client.close();
      publisher.close();
      await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
      await server.observability.close();
      if (before === undefined) delete process.env.CCMUX_CONFIG;
      else process.env.CCMUX_CONFIG = before;
    }
  });
});
