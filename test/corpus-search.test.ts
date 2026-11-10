import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { histFile } from '../src/agent/claude/resume.ts';
import { getProvider } from '../src/agent/index.ts';
import { readTranscriptFile } from '../src/agent/transcript/transcriptRead.ts';
import {
  mapLines,
  parseSearch,
  parseWhen,
  searchFleet,
  searchLines,
} from '../src/commands/search.ts';
import {
  type CorpusQuery,
  fileLines,
  isHarnessText,
  searchStored,
} from '../src/context/corpusSearch.ts';
import { dealOut, searchMachine, shardCount } from '../src/context/corpusShards.ts';
import { storedConversations } from '../src/context/storedConversations.ts';
import { compilePattern } from '../src/context/transcriptSearch.ts';
import { readExternalTranscript, withExternalTranscript } from '../src/external/transcript.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * A search with no session in it owes what the single-conversation search owes, across a store: it
 * reads conversations nobody is running any more, it names each match by an address that opens it,
 * and by default it finds what was SAID — not what a tool printed or what the harness injected.
 */
const L = (o: unknown): string => JSON.stringify(o);

const MANAGED = '11111111-1111-4111-8111-111111111111';
const FINISHED = '22222222-2222-4222-8222-222222222222';
const CODEX_LIVE = '0199aaaa-0000-7000-8000-000000000001';
const CODEX_OLD = '0199aaaa-0000-7000-8000-000000000002';

const claudeLine = (
  uuid: string,
  role: 'user' | 'assistant' | 'system',
  content: unknown,
  at: string,
  cwd: string,
) =>
  L({
    type: role,
    uuid,
    sessionId: cwd === '/gone/project' ? FINISHED : MANAGED,
    timestamp: at,
    cwd,
    message: { role, content },
  });

const codexSay = (role: 'user' | 'assistant', text: string, at: string) =>
  L({
    type: 'response_item',
    timestamp: at,
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  });

interface Store {
  m: MachineConfig;
  sessions: Session[];
  projectDir: string;
}

function store(): Store {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-corpus-'));
  const projectsDir = join(root, 'claude', 'projects');
  const codexSessionsDir = join(root, 'codex', 'sessions');
  const projectDir = join(root, 'work', 'api');
  mkdirSync(projectDir, { recursive: true });
  const m = makeMachine({ projectsDir, codexSessionsDir, rcPrefix: 'host-a', stateDir: root });
  const managed = makeSession({ name: 'agent-a', uuid: MANAGED, dir: projectDir });
  const write = (path: string, lines: string[]) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  };
  // The conversation a session is reading now.
  write(histFile(projectDir, MANAGED, projectsDir), [
    claudeLine(
      'm1',
      'user',
      [{ type: 'text', text: 'how do we roll back the gateway' }],
      '2026-09-01T10:00:00.000Z',
      projectDir,
    ),
    claudeLine(
      'm2',
      'assistant',
      [{ type: 'text', text: 'Rollback is one command.' }],
      '2026-09-01T10:00:05.000Z',
      projectDir,
    ),
  ]);
  // A conversation whose session is gone: nothing in the registry names it.
  write(join(projectsDir, '-gone-project', `${FINISHED}.jsonl`), [
    claudeLine(
      'f1',
      'user',
      [{ type: 'text', text: 'the heron migration plan' }],
      '2026-07-10T08:00:00.000Z',
      '/gone/project',
    ),
    claudeLine(
      'f2',
      'assistant',
      [{ type: 'thinking', thinking: 'the kestrel idea stays private' }],
      '2026-07-10T08:00:01.000Z',
      '/gone/project',
    ),
    claudeLine(
      'f3',
      'assistant',
      [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo osprey' } }],
      '2026-07-10T08:00:02.000Z',
      '/gone/project',
    ),
    claudeLine(
      'f4',
      'user',
      [{ type: 'tool_result', tool_use_id: 't1', content: 'osprey printed by the tool' }],
      '2026-07-10T08:00:03.000Z',
      '/gone/project',
    ),
    claudeLine(
      'f5',
      'system',
      [{ type: 'text', text: 'hook says heron is configured' }],
      '2026-07-10T08:00:04.000Z',
      '/gone/project',
    ),
    claudeLine(
      'f6',
      'assistant',
      [{ type: 'text', text: 'Heron moves on Friday.' }],
      '2026-07-10T08:00:05.000Z',
      '/gone/project',
    ),
  ]);
  // A spawned agent's transcript beside it is tool work, not a conversation.
  write(join(projectsDir, '-gone-project', FINISHED, 'subagents', 'agent-a1.jsonl'), [
    claudeLine(
      's1',
      'assistant',
      [{ type: 'text', text: 'heron seen by a spawned agent' }],
      '2026-07-10T08:00:02.500Z',
      '/gone/project',
    ),
  ]);
  const meta = (id: string) => L({ type: 'session_meta', payload: { id, cwd: '/srv/codex-work' } });
  write(
    join(codexSessionsDir, '2026', '08', '01', `rollout-2026-08-01T00-00-00-${CODEX_LIVE}.jsonl`),
    [
      meta(CODEX_LIVE),
      codexSay('user', 'where does the heron config live', '2026-08-01T00:00:01.000Z'),
      codexSay('assistant', 'In the gateway repository.', '2026-08-01T00:00:02.000Z'),
    ],
  );
  // Compressed by the provider once the thread went idle.
  const old = [
    meta(CODEX_OLD),
    codexSay('assistant', 'The heron cutover is done.', '2026-06-01T00:00:01.000Z'),
  ];
  mkdirSync(join(codexSessionsDir, '2026', '06', '01'), { recursive: true });
  writeFileSync(
    join(
      codexSessionsDir,
      '2026',
      '06',
      '01',
      `rollout-2026-06-01T00-00-00-${CODEX_OLD}.jsonl.zst`,
    ),
    zstdCompressSync(Buffer.from(old.map((line) => `${line}\n`).join(''))),
  );
  return { m, sessions: [managed], projectDir };
}

async function withStore<T>(run: (s: Store) => Promise<T>): Promise<T> {
  const s = store();
  try {
    return await run(s);
  } finally {
    rmSync(s.m.stateDir, { recursive: true, force: true });
  }
}

const query = (pattern: string, over: Partial<CorpusQuery> = {}): CorpusQuery => ({
  pattern: compilePattern(pattern),
  kinds: new Set(['message']),
  roles: new Set(['user', 'assistant']),
  limit: 50,
  ...over,
});

const find = (s: Store, q: CorpusQuery) =>
  searchStored(s.m.rcPrefix, q, storedConversations(s.m, s.sessions));

test('a finished conversation is found without naming it, under an address that opens it', async () => {
  await withStore(async (s) => {
    const { matches, coverage } = await find(s, query('heron'));
    const finished = matches.filter((match) => match.threadId === FINISHED);
    expect(finished.map((match) => [match.seq, match.role])).toEqual([
      [1, 'user'],
      [6, 'assistant'],
    ]);
    expect(finished[0]?.address).toBe(`external:claude:host-a#${FINISHED}`);
    expect(finished[0]?.dir).toBe('/gone/project');
    expect(finished[0]?.lines).toBe(true);
    // The address and the line are what the transcript reader takes: the same record comes back.
    const { read } = await readExternalTranscript(
      s.m,
      { provider: 'claude', threadId: FINISHED },
      { tail: 1, before: 7, limit: 1 },
    );
    expect(read.messages.map((message) => [message.seq, message.text])).toEqual([
      [6, 'Heron moves on Friday.'],
    ]);
    expect(coverage).toMatchObject({ machine: 'host-a', conversations: 4, files: 4, total: 4 });
  });
});

test('the conversation a session reads is addressed by that session', async () => {
  await withStore(async (s) => {
    const { matches } = await find(s, query('roll ?back'));
    expect(matches.map((match) => [match.address, match.session, match.seq, match.role])).toEqual([
      ['host-a:agent-a', 'agent-a', 1, 'user'],
      ['host-a:agent-a', 'agent-a', 2, 'assistant'],
    ]);
  });
});

test('Codex is searched too, and a compressed file is read but not offered by line', async () => {
  await withStore(async (s) => {
    const { matches } = await find(s, query('heron', { providers: new Set(['codex']) }));
    expect(matches.map((match) => [match.address, match.seq, match.lines, match.dir])).toEqual([
      [`external:codex:host-a#${CODEX_OLD}`, 2, false, '/srv/codex-work'],
      [`external:codex:host-a#${CODEX_LIVE}`, 2, true, '/srv/codex-work'],
    ]);
    const { read } = await readExternalTranscript(
      s.m,
      { provider: 'codex', threadId: CODEX_LIVE },
      { tail: 1, before: 3, limit: 1 },
    );
    expect(read.messages.map((message) => message.text)).toEqual([
      'where does the heron config live',
    ]);
  });
});

test('thinking, tool traffic, harness records and spawned agents are not matches by default', async () => {
  await withStore(async (s) => {
    // Each of these words exists in the store only where a default search must not look.
    expect((await find(s, query('kestrel'))).coverage.total).toBe(0);
    expect((await find(s, query('osprey'))).coverage.total).toBe(0);
    expect((await find(s, query('configured'))).coverage.total).toBe(0);
    expect((await find(s, query('spawned agent'))).coverage.total).toBe(0);
    // And each is found the moment the caller asks for that kind or role — so the silence above is
    // the default, not blindness.
    const all = new Set(['message', 'thinking', 'tool_call', 'tool_result'] as const);
    const { roles: _roles, ...unfiltered } = query('x');
    const widened = (pattern: string): CorpusQuery => ({
      ...unfiltered,
      pattern: compilePattern(pattern),
      kinds: all,
    });
    expect((await find(s, widened('kestrel'))).matches.map((m) => m.kind)).toEqual(['thinking']);
    expect((await find(s, widened('osprey'))).matches.map((m) => m.kind)).toEqual(['tool_call']);
    expect((await find(s, widened('configured'))).matches.map((m) => m.role)).toEqual(['system']);
  });
});

test('role, date, directory and provider each narrow the answer', async () => {
  await withStore(async (s) => {
    const addresses = async (over: Partial<CorpusQuery>) =>
      (await find(s, query('heron', over))).matches.map(
        (match) => `${match.threadId}:${match.seq}`,
      );
    expect(await addresses({})).toEqual([
      `${CODEX_OLD}:2`,
      `${FINISHED}:1`,
      `${FINISHED}:6`,
      `${CODEX_LIVE}:2`,
    ]);
    expect(await addresses({ roles: new Set(['user']) })).toEqual([
      `${FINISHED}:1`,
      `${CODEX_LIVE}:2`,
    ]);
    expect(await addresses({ since: Date.parse('2026-07-01T00:00:00Z') })).toEqual([
      `${FINISHED}:1`,
      `${FINISHED}:6`,
      `${CODEX_LIVE}:2`,
    ]);
    expect(await addresses({ until: Date.parse('2026-07-31T00:00:00Z') })).toEqual([
      `${CODEX_OLD}:2`,
      `${FINISHED}:1`,
      `${FINISHED}:6`,
    ]);
    expect(await addresses({ project: 'GONE/proj' })).toEqual([`${FINISHED}:1`, `${FINISHED}:6`]);
    expect(await addresses({ providers: new Set(['claude']) })).toEqual([
      `${FINISHED}:1`,
      `${FINISHED}:6`,
    ]);
    // The newest are the ones kept, and the total still counts the rest.
    const limited = await find(s, query('heron', { limit: 1 }));
    expect(limited.matches.map((match) => match.threadId)).toEqual([CODEX_LIVE]);
    expect(limited.coverage.total).toBe(4);
  });
});

test('a line number is the one the transcript index gives the same record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-corpus-lines-'));
  try {
    const path = join(dir, `${FINISHED}.jsonl`);
    // A multi-byte character and a line that arrives in several reads: it has to be put back
    // together from every piece, with no character cut at a join.
    const long = 'я'.repeat(5_000_000);
    const lines = [
      claudeLine('a', 'user', [{ type: 'text', text: long }], '2026-09-01T00:00:00.000Z', '/p'),
      '',
      claudeLine(
        'b',
        'assistant',
        [{ type: 'text', text: 'the marker' }],
        '2026-09-01T00:00:01.000Z',
        '/p',
      ),
    ];
    // The last record is still being written: no newline yet.
    writeFileSync(path, `${lines.join('\n')}\n{"type":"assistant","uuid":"partial`);
    const seen: { base: number; count: number }[] = [];
    const texts: string[] = [];
    for await (const batch of fileLines({ path, compressed: false }, 1)) {
      seen.push({ base: batch.base, count: batch.lines.length });
      texts.push(...batch.lines);
    }
    expect(texts).toEqual(lines);
    expect(seen.reduce((sum, batch) => sum + batch.count, 0)).toBe(3);
    const indexed = readTranscriptFile(path, getProvider('claude'), { tail: 10 });
    const marker = indexed.messages.find((message) => message.text === 'the marker');
    const found = await searchStored('host-a', query('marker'), [
      {
        provider: 'claude',
        threadId: FINISHED,
        address: 'x',
        session: null,
        dir: null,
        files: [{ path, compressed: false, lines: true, startMs: null }],
      },
    ]);
    expect(found.matches.map((match) => match.seq)).toEqual([marker?.seq as number]);
    expect(marker?.seq).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('several processes give the answer one process gives', async () => {
  await withStore(async (s) => {
    const conversations = storedConversations(s.m, s.sessions);
    const one = await searchMachine('host-a', query('heron'), conversations, 1);
    const three = await searchMachine('host-a', query('heron'), conversations, 3);
    expect(three.matches).toEqual(one.matches);
    const { elapsedMs: _a, ...counted } = one.coverage;
    const { elapsedMs: _b, ...shared } = three.coverage;
    expect(shared).toEqual(counted);
    expect(one.coverage.total).toBe(4);
  });
});

test('shares are sized by bytes and never outnumber the work', () => {
  expect(shardCount(10 * 1024 ** 2, 16)).toBe(1);
  expect(shardCount(64 * 1024 ** 3, 16)).toBe(6);
  expect(shardCount(64 * 1024 ** 3, 2)).toBe(1);
  const shares = dealOut(
    [9, 1, 1, 1, 6, 2].map((bytes, item) => ({ item, bytes })),
    2,
  );
  const weight = (share: number[]) =>
    share.reduce((sum, item) => sum + ([9, 1, 1, 1, 6, 2][item] ?? 0), 0);
  expect(shares.map(weight).sort()).toEqual([10, 10]);
});

test('a machine that did not answer is named, and is not a clean "nothing found"', async () => {
  await withStore(async (s) => {
    const m = { ...s.m, fleet: { 'host-a': 'self', 'host-b': 'ccmux-test-unreachable.invalid' } };
    const opts = parseSearch(['no-such-phrase-anywhere', '--machine', 'host-b,host-c']);
    const result = await searchFleet(m, opts, async () => ({
      code: 255,
      stdout: '',
      stderr: '',
      transportFailed: true,
      delivery: 'unknown',
      failureDetail: 'connection timed out',
    }));
    expect(result.machines).toEqual([
      { machine: 'host-b', status: 'unavailable', error: 'connection timed out' },
      {
        machine: 'host-c',
        status: 'unavailable',
        error: 'not a machine of this fleet (see ccmux fleet)',
      },
    ]);
    const text = searchLines(result, Date.now(), false).join('\n');
    expect(text).toContain('NOT SEARCHED: host-b — connection timed out');
    expect(text).toContain('no matches');
  });
});

test('a peer is asked for the same search on its own store, and an older peer is not "no matches"', async () => {
  await withStore(async (s) => {
    const m = { ...s.m, fleet: { 'host-b': 'alias-b' } };
    const asked: string[][] = [];
    const opts = parseSearch([
      'Heron|kestrel',
      '--role',
      'user',
      '--since',
      '2026-07-01',
      '--machine',
      'host-b',
    ]);
    const older = await searchFleet(m, opts, async (_m, _machine, _alias, argv) => {
      asked.push(argv);
      return {
        code: 1,
        stdout: '',
        stderr: "unknown command 'search'\n",
        transportFailed: false,
        delivery: 'received',
      };
    });
    expect(asked[0]?.slice(0, 4)).toEqual(['ccmux', 'search', '--local', '--json']);
    expect(asked[0]?.slice(-2)).toEqual(['--', 'Heron|kestrel']);
    expect(asked[0]).toContain('--case-sensitive');
    expect(asked[0]?.[asked[0].indexOf('--since') + 1]).toBe(new Date(2026, 6, 1).toISOString());
    expect(older.machines[0]).toMatchObject({ machine: 'host-b', status: 'unavailable' });
    expect(older.machines[0]).toHaveProperty(
      'error',
      expect.stringContaining("unknown command 'search'"),
    );

    // A current peer: its answer is what `search --local --json` prints there.
    const there = await searchFleet(
      { ...s.m, rcPrefix: 'host-b' },
      parseSearch(['heron', '--local']),
    );
    const merged = await searchFleet(m, parseSearch(['heron']), async () => ({
      code: 0,
      stdout: JSON.stringify(there),
      stderr: '',
      transportFailed: false,
      delivery: 'received',
    }));
    expect(merged.machines.map((row) => [row.machine, row.status])).toEqual([
      ['host-a', 'searched'],
      ['host-b', 'searched'],
    ]);
    expect(merged.total).toBe(8);
    expect(new Set(merged.matches.map((match) => match.machine))).toEqual(
      new Set(['host-a', 'host-b']),
    );
    // An answer that names another machine than the one asked is not that machine's answer.
    const wrong = await searchFleet(
      { ...m, fleet: { 'host-c': 'alias-c' } },
      parseSearch(['heron', '--machine', 'host-c']),
      async () => ({
        code: 0,
        stdout: JSON.stringify(there),
        stderr: '',
        transportFailed: false,
        delivery: 'received',
      }),
    );
    expect(wrong.machines[0]).toMatchObject({ machine: 'host-c', status: 'unavailable' });
  });
});

test('a day is the whole day, and a relative time counts back from now', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  expect(parseWhen('7d', 'since', now)).toBe(now - 7 * 86_400_000);
  expect(parseWhen('12h', 'until', now)).toBe(now - 12 * 3_600_000);
  expect(parseWhen('2026-11-03', 'since', now)).toBe(new Date(2026, 10, 3).getTime());
  expect(parseWhen('2026-11-03', 'until', now)).toBe(new Date(2026, 10, 4).getTime() - 1);
  expect(() => parseWhen('yesterday-ish', 'since', now)).toThrow('--since');
});

test('the matches are printed under the address that opens them', async () => {
  await withStore(async (s) => {
    const result = await searchFleet(
      s.m,
      parseSearch(['heron', '--local', '--provider', 'claude']),
      undefined,
      s.sessions,
    );
    const lines = searchLines(result, Date.parse('2026-07-11T08:00:00Z'), false);
    expect(lines[0]).toBe(`external:claude:host-a#${FINISHED}  claude  /gone/project`);
    expect(lines[1]).toMatch(/^ {2}SEQ +AGE +ROLE +KIND +MATCH$/);
    expect(lines[2]).toMatch(/^ {2}1 +1d +user +message +the heron migration plan$/);
    expect(lines.at(-1)).toBe(
      `SEQ is a line: ccmux transcript 'external:claude:host-a#${FINISHED}' --json --before 7 --limit 20 reads what led up to it`,
    );
  });
});

test('a file no message in range can be in is not read, and one that can is', async () => {
  await withStore(async (s) => {
    const finished = join(s.m.projectsDir, '-gone-project', `${FINISHED}.jsonl`);
    // Last written in July: nothing in it is from August.
    utimesSync(finished, new Date('2026-07-11T00:00:00Z'), new Date('2026-07-11T00:00:00Z'));
    const august = await find(s, query('heron', { since: Date.parse('2026-08-01T00:00:00Z') }));
    expect(august.matches.map((match) => match.threadId)).toEqual([CODEX_LIVE]);
    expect(august.coverage).toMatchObject({ files: 3, skippedFiles: 1 });
    // The same file is read when the range reaches back to it.
    const july = await find(s, query('heron', { since: Date.parse('2026-07-01T00:00:00Z') }));
    expect(july.matches.filter((match) => match.threadId === FINISHED)).toHaveLength(2);
    expect(july.coverage).toMatchObject({ files: 4, skippedFiles: 0 });
    // A Codex file started after the range ends holds nothing from inside it. These ids carry
    // their start time, late in 2025.
    const early = await find(s, query('heron', { until: Date.parse('2025-01-01T00:00:00Z') }));
    expect(early.coverage).toMatchObject({ files: 2, skippedFiles: 2, total: 0 });
  });
});

test('with nothing said about role or kind, a search is for what the two sides said', () => {
  const plain = parseSearch(['heron']).query;
  expect([...plain.kinds]).toEqual(['message']);
  expect([...(plain.roles ?? [])]).toEqual(['user', 'assistant']);
  // Naming a kind is choosing: a tool result's role is `tool`, and assuming a role would hide it.
  const tools = parseSearch(['heron', '--kind', 'tool_result']).query;
  expect([...tools.kinds]).toEqual(['tool_result']);
  expect(tools.roles).toBeUndefined();
  expect([...(parseSearch(['heron', '--role', 'system']).query.roles ?? [])]).toEqual(['system']);
  expect(() => parseSearch(['heron', '--local', '--machine', 'host-b'])).toThrow(
    '--local or --machine',
  );
});

test('without a pattern the answer is an outline: each request and the last answer to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-corpus-outline-'));
  try {
    const path = join(dir, `${FINISHED}.jsonl`);
    const text = (value: string) => [{ type: 'text', text: value }];
    const at = (second: number) => `2026-09-01T00:00:${String(second).padStart(2, '0')}.000Z`;
    const lines = [
      claudeLine(
        '1',
        'user',
        text('<system-reminder>injected by the harness</system-reminder>'),
        at(0),
        '/p',
      ),
      claudeLine('2', 'user', text('first request'), at(1), '/p'),
      claudeLine('3', 'assistant', text('working on it'), at(2), '/p'),
      claudeLine(
        '4',
        'assistant',
        [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }],
        at(3),
        '/p',
      ),
      claudeLine('5', 'assistant', text('first answer'), at(4), '/p'),
      claudeLine(
        '6',
        'user',
        text('<task-notification>a background task ended</task-notification>'),
        at(5),
        '/p',
      ),
      claudeLine('7', 'user', text('second request'), at(6), '/p'),
      claudeLine('8', 'assistant', text('second answer'), at(7), '/p'),
    ];
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    const conversation = {
      provider: 'claude' as const,
      threadId: FINISHED,
      address: 'host-a:agent-a',
      session: 'agent-a',
      dir: '/p',
      files: [{ path, compressed: false, lines: true, startMs: null }],
    };
    const { pattern: _pattern, ...outline } = query('x');
    const found = await searchStored('host-a', outline, [conversation]);
    // The intermediate "working on it" is not an answer, and the harness's records are not the user.
    expect(found.matches.map((match) => [match.seq, match.role, match.excerpt.match])).toEqual([
      [2, 'user', 'first request'],
      [5, 'assistant', 'first answer'],
      [7, 'user', 'second request'],
      [8, 'assistant', 'second answer'],
    ]);
    // What the harness injected is still there for a caller who asks for it by its real role.
    const harness = await searchStored(
      'host-a',
      query('harness|background', { roles: new Set(['system']) }),
      [conversation],
    );
    expect(harness.matches.map((match) => match.seq)).toEqual([1, 6]);
    for (const injected of [
      '<environment_context> <cwd>/srv</cwd>',
      '# AGENTS.md instructions for /srv/work',
      '# AGENTS.md instructions\n\n<INSTRUCTIONS>',
      '</image>',
      '<image name=[Image #1] path="/tmp/a.png">',
      'Your response above was stopped by a safety classifier',
    ])
      expect(isHarnessText(injected)).toBe(true);
    // What a person wrote stays theirs, whatever it opens with.
    for (const written of ['# Files mentioned by the user: ## a.ts', '<div> is broken', '/compact'])
      expect(isHarnessText(written)).toBe(false);
    expect(
      (await searchStored('host-a', query('harness|background'), [conversation])).coverage.total,
    ).toBe(0);
    expect(() => parseSearch([])).toThrow('--project or --since');
    expect(parseSearch(['--project', 'api']).query.pattern).toBeUndefined();
    expect(parseSearch(['--since', 'today'], Date.parse('2026-11-10T12:00:00')).query.since).toBe(
      new Date(2026, 10, 10).getTime(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the map counts every match of a conversation, not only the lines that fit the limit', async () => {
  await withStore(async (s) => {
    const result = await searchFleet(
      s.m,
      parseSearch(['heron', '--local', '--limit', '1']),
      undefined,
      s.sessions,
    );
    expect(result.matches).toHaveLength(1);
    expect(
      result.conversations.map((row) => [
        row.threadId,
        row.total,
        row.user,
        row.assistant,
        row.sample.seq,
      ]),
    ).toEqual([
      [CODEX_OLD, 1, 0, 1, 2],
      [FINISHED, 2, 1, 1, 6],
      [CODEX_LIVE, 1, 1, 0, 2],
    ]);
    const lines = mapLines(result, Date.parse('2026-08-02T00:00:01Z'), 2);
    expect(lines[0]).toMatch(/^ADDRESS +DIR +ALL +USER +AGENT +FIRST +LAST$/);
    expect(lines[1]).toMatch(
      new RegExp(`^external:claude:host-a#${FINISHED} +/gone/project +2 +1 +1 +2026-07-10 +22d`),
    );
    expect(lines[2]).toBe('    assistant: Heron moves on Friday.');
    expect(lines.join('\n')).toContain('showing the 2 conversations matched most recently of 3');
    expect(lines.join('\n')).toContain('4 matches in 3 conversation(s)');
    // A session's name narrows like its directory does.
    const named = await searchFleet(
      s.m,
      parseSearch(['roll', '--local', '--project', 'AGENT-a']),
      undefined,
      s.sessions,
    );
    expect(named.conversations.map((row) => row.address)).toEqual(['host-a:agent-a']);
  });
});

test("a conversation in another profile's store is found and opened by the same address", async () => {
  await withStore(async (s) => {
    // A session declares another Claude profile; an earlier conversation of that profile is on disk
    // under no session at all.
    const profile = join(s.m.stateDir, 'profile-b');
    const envFile = join(s.m.stateDir, 'profile-b.env');
    writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${profile}\n`);
    const second = makeSession({
      name: 'agent-b',
      uuid: '33333333-3333-4333-8333-333333333333',
      dir: s.projectDir,
      envFile,
    });
    const earlier = '44444444-4444-4444-8444-444444444444';
    const path = join(profile, 'projects', '-other-profile', `${earlier}.jsonl`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      `${L({
        type: 'user',
        uuid: 'p1',
        sessionId: earlier,
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/other/profile',
        message: { role: 'user', content: [{ type: 'text', text: 'the plover question' }] },
      })}\n`,
    );
    const sessions = [...s.sessions, second];
    const { matches } = await searchStored(
      s.m.rcPrefix,
      query('plover'),
      storedConversations(s.m, sessions),
    );
    expect(matches.map((match) => [match.address, match.seq, match.lines])).toEqual([
      [`external:claude:host-a#${earlier}`, 1, true],
    ]);
    const opened = await withExternalTranscript(
      s.m,
      { provider: 'claude', threadId: earlier },
      (found) => found,
      undefined,
      sessions,
    );
    expect(opened).toMatchObject({ source: 'readable', value: realpathSync(path) });
    // Without that session nothing declares the profile, and the address has nowhere to resolve.
    const undeclared = await withExternalTranscript(
      s.m,
      { provider: 'claude', threadId: earlier },
      (found) => found,
      undefined,
      s.sessions,
    );
    expect(undeclared.source).toBe('missing');
  });
});

test('a message sent while the agent was working is the user speaking, at the time it was sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-corpus-queued-'));
  try {
    const path = join(dir, `${FINISHED}.jsonl`);
    const text = (value: string) => [{ type: 'text', text: value }];
    const queued = (uuid: string, prompt: unknown, at: string, human: boolean) =>
      L({
        type: 'attachment',
        uuid,
        sessionId: FINISHED,
        timestamp: at,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: human ? 'prompt' : 'task-notification',
          ...(human ? { humanTurn: true } : {}),
        },
      });
    // What was sent to the model, kept by hash: no time, and a copy of everything around it.
    const blob = (content: unknown) =>
      L({
        type: 'api-request-blob',
        sessionId: FINISHED,
        hash: 'h',
        message: { role: 'user', content },
      });
    const lines = [
      claudeLine('1', 'user', text('start the work'), '2026-09-01T00:00:01.000Z', '/gone/project'),
      claudeLine(
        '2',
        'assistant',
        [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }],
        '2026-09-01T00:00:02.000Z',
        '/gone/project',
      ),
      queued('3', 'the wagtail remark, said mid-turn', '2026-09-01T00:00:03.000Z', true),
      blob([
        {
          type: 'tool_result',
          tool_use_id: 't',
          content: 'only the copy carries the dunlin output',
        },
        {
          type: 'text',
          text: 'The user sent a new message while you were working:\nthe wagtail remark, said mid-turn',
        },
      ]),
      queued(
        '5',
        '<task-notification>\n<tool-use-id>t</tool-use-id>\n<status>completed</status>\n</task-notification>',
        '2026-09-01T00:00:04.000Z',
        false,
      ),
      queued(
        '6',
        [{ type: 'text', text: 'a second wagtail remark, as blocks' }],
        '2026-09-01T00:00:05.000Z',
        true,
      ),
      claudeLine('7', 'assistant', text('done'), '2026-09-01T00:00:06.000Z', '/gone/project'),
    ];
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    const conversation = {
      provider: 'claude' as const,
      threadId: FINISHED,
      address: 'host-a:agent-a',
      session: 'agent-a',
      dir: '/gone/project',
      files: [{ path, compressed: false, lines: true, startMs: null }],
    };
    // Found once each, as the user, with its own time — so a date range and "the newest" hold it.
    const found = await searchStored(
      'host-a',
      query('wagtail', { since: Date.parse('2026-09-01T00:00:00Z') }),
      [conversation],
    );
    expect(found.matches.map((match) => [match.seq, match.role, match.createdAt])).toEqual([
      [3, 'user', '2026-09-01T00:00:03.000Z'],
      [6, 'user', '2026-09-01T00:00:05.000Z'],
    ]);
    // The copy is not the conversation: what only it carries is not found, whatever is asked for.
    const all = new Set(['message', 'thinking', 'tool_call', 'tool_result'] as const);
    const { roles: _roles, ...anyRole } = query('dunlin');
    expect(
      (await searchStored('host-a', { ...anyRole, kinds: all }, [conversation])).coverage.total,
    ).toBe(0);
    // The outline has both remarks, and the runtime's queued notice is not one of the user's.
    const { pattern: _pattern, ...outline } = query('x');
    const said = await searchStored('host-a', outline, [conversation]);
    expect(said.matches.map((match) => [match.seq, match.role])).toEqual([
      [1, 'user'],
      [3, 'user'],
      [6, 'user'],
      [7, 'assistant'],
    ]);
    // `ccmux transcript` reads through the same parser: the same two lines, the same role and time.
    const read = readTranscriptFile(path, getProvider('claude'), { tail: 100 });
    expect(
      read.messages
        .filter((message) => message.role === 'user')
        .map((message) => [message.seq, message.createdAt !== null]),
    ).toEqual([
      [1, true],
      [3, true],
      [5, true],
      [6, true],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
