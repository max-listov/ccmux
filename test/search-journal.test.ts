import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSearchReport, reportLines } from '../src/commands/searchReport.ts';
import { searchJournalPath } from '../src/config/paths.ts';
import type { CorpusSearchJson } from '../src/context/corpusSearchSchema.ts';
import { searchFleet } from '../src/context/searchFleet.ts';
import type { SearchFrame } from '../src/context/searchFrames.ts';
import {
  commandCaller,
  journalEntry,
  journaledFrames,
  journalSearch,
  readSearchJournal,
  type SearchJournalEntry,
} from '../src/context/searchJournal.ts';
import { searchReport } from '../src/context/searchReport.ts';
import type { PeerRunner } from '../src/fleet/askPeer.ts';
import { makeMachine } from './helpers.ts';

/**
 * A search leaves one line where it was asked — who, what, how each machine answered, how long — and
 * nothing on a machine asked on another's behalf; the report reads every machine's lines and says
 * which machine it could not read.
 */

const QUERY: CorpusSearchJson['query'] = {
  pattern: 'rollback',
  flags: 'i',
  roles: ['user', 'assistant'],
  kinds: ['message'],
  providers: null,
  project: null,
  since: null,
  until: null,
  limit: 50,
  full: false,
};

const searched = (machine: string, total: number) => ({
  machine,
  status: 'searched' as const,
  elapsedMs: 10,
  conversations: 1,
  files: 1,
  bytes: 1,
  skippedFiles: 0,
  unreadableFiles: 0,
  total,
});

const stateRoot = () => ({ stateDir: mkdtempSync(join(tmpdir(), 'ccmux-search-journal-')) });

const line = (
  at: string,
  over: Partial<SearchJournalEntry> = {},
  answer: Pick<SearchJournalEntry, 'query' | 'machines' | 'total'> = {
    query: QUERY,
    machines: [searched('host-a', 3)],
    total: 3,
  },
): SearchJournalEntry => ({
  ...journalEntry({
    via: 'cli',
    caller: 'host-a:agent-a',
    dir: '/w/api',
    map: false,
    answer,
    startedAt: Date.parse(at) - 1500,
    now: Date.parse(at),
  }),
  ...over,
});

test('the caller is the session the environment names, or nobody', () => {
  const thread = '11111111-1111-4111-8111-111111111111';
  expect(
    commandCaller('host-a', { CCMUX_SESSION: 'agent-a', CLAUDE_CODE_SESSION_ID: thread }),
  ).toBe('host-a:agent-a');
  expect(commandCaller('host-a', { CLAUDE_CODE_SESSION_ID: thread })).toBe(
    `external:claude:host-a#${thread}`,
  );
  expect(commandCaller('host-a', { CODEX_THREAD_ID: thread })).toBe(
    `external:codex:host-a#${thread}`,
  );
  expect(commandCaller('host-a', {})).toBeNull();
});

test('a line says what was asked and how it went, and the mode names the question', () => {
  const entry = line('2026-11-12T08:00:00.000Z');
  expect([entry.mode, entry.total, entry.elapsedMs, entry.machines.length]).toEqual([
    'lines',
    3,
    1500,
    1,
  ]);
  const answer = { query: QUERY, machines: [], total: 0 };
  const mode = (query: CorpusSearchJson['query'], map: boolean) =>
    journalEntry({
      via: 'cli',
      caller: null,
      dir: null,
      map,
      answer: { ...answer, query },
      startedAt: 0,
      now: 0,
    }).mode;
  expect(mode(QUERY, true)).toBe('map');
  expect(mode({ ...QUERY, pattern: null, since: '2026-11-12T00:00:00.000Z' }, false)).toBe(
    'outline',
  );
  expect(mode({ ...QUERY, receipts: true }, false)).toBe('receipts');
});

test('the journal is read for a period across rotations, and a line it cannot read is counted', () => {
  const m = stateRoot();
  const path = searchJournalPath(m);
  writeFileSync(`${path}.1`, `${JSON.stringify(line('2026-11-01T08:00:00.000Z'))}\n`);
  journalSearch(m, line('2026-11-10T08:00:00.000Z'));
  appendFileSync(path, 'not json\n');
  appendFileSync(path, `${JSON.stringify({ at: '2026-11-11T08:00:00.000Z', via: 'cli' })}\n`);
  journalSearch(m, line('2026-11-12T08:00:00.000Z', { caller: 'host-a:agent-b' }));
  const all = readSearchJournal(m, 0, null);
  expect(all.entries.map((entry) => entry.at)).toEqual([
    '2026-11-01T08:00:00.000Z',
    '2026-11-10T08:00:00.000Z',
    '2026-11-12T08:00:00.000Z',
  ]);
  expect(all.unreadable).toBe(2);
  const period = readSearchJournal(
    m,
    Date.parse('2026-11-05T00:00:00.000Z'),
    Date.parse('2026-11-11T00:00:00.000Z'),
  );
  expect(period.entries.map((entry) => entry.at)).toEqual(['2026-11-10T08:00:00.000Z']);
});

test('a search asked here is written; one another machine asked for is not', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-search-cli-')));
  const state = join(home, 'state');
  const run = (...args: string[]) =>
    Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'search', ...args], {
      env: {
        ...process.env,
        HOME: home,
        CCMUX_STATE_DIR: state,
        CCMUX_SESSION: 'agent-a',
        CCMUX_CONFIG: join(home, 'no-config.json'),
      },
      cwd: home,
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
  expect(await run('zz-never-said', '--local')).toBe(1);
  expect(await run('zz-never-said', '--local', '--json', '--asked-by', 'host-b')).toBe(1);
  const lines = readFileSync(searchJournalPath({ stateDir: state }), 'utf8')
    .trim()
    .split('\n');
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] as string) as SearchJournalEntry;
  expect([entry.via, entry.caller?.endsWith(':agent-a'), entry.dir, entry.query.pattern]).toEqual([
    'cli',
    true,
    home,
    'zz-never-said',
  ]);
  expect(entry.total).toBe(0);
});

test('a fleet search tells each machine it asks whose search it is', async () => {
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: mkdtempSync(join(tmpdir(), 'ccmux-search-asks-')),
    projectsDir: '/nonexistent',
    fleet: { 'host-b': 'host-b' },
  });
  const asked: string[][] = [];
  const runPeer: PeerRunner = async (_m, _machine, _alias, argv) => {
    asked.push(argv);
    return { code: 1, stdout: '', stderr: '', transportFailed: true, delivery: 'not-sent' };
  };
  await searchFleet(
    m,
    {
      query: { kinds: new Set(['message']), limit: 50 },
      machines: ['host-b'],
      peerArgs: ['--', 'x'],
    },
    runPeer,
    [],
  );
  expect(asked[0]?.slice(0, 6)).toEqual([
    'ccmux',
    'search',
    '--local',
    '--json',
    '--asked-by',
    'host-a',
  ]);
});

test('a control search is written when its last frame says what was searched, and not if left', async () => {
  const end: SearchFrame = {
    frame: 'end',
    query: QUERY,
    machines: [searched('host-a', 2)],
    total: 2,
    truncated: false,
  };
  const mark: SearchFrame = {
    frame: 'mark',
    mark: 'aaaa1111',
    deliveries: [
      {
        machine: 'host-a',
        address: 'host-a:agent-a',
        provider: 'claude',
        threadId: '11111111-1111-4111-8111-111111111111',
        session: 'agent-a',
        ofSession: 'agent-a',
        dir: null,
        repository: null,
        lines: true,
        seq: 8,
        receivedAt: '2026-11-12T08:00:00.000Z',
        role: 'user',
        messageId: '8:0',
      },
    ],
  };
  async function* stream(frames: SearchFrame[]) {
    yield* frames;
  }
  const recorded: SearchFrame[] = [];
  const passed: SearchFrame[] = [];
  for await (const frame of journaledFrames(stream([mark, end]), (last) => recorded.push(last)))
    passed.push(frame);
  expect([passed, recorded]).toEqual([[mark, end], [end]]);
  const left: SearchFrame[] = [];
  for await (const _ of journaledFrames(stream([mark]), (last) => left.push(last))) void _;
  expect(left).toEqual([]);
});

test('the report reads every machine, counts what it could not read, and names a silent machine', async () => {
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: mkdtempSync(join(tmpdir(), 'ccmux-search-report-')),
    fleet: { 'host-b': 'host-b', 'host-c': 'host-c' },
  });
  journalSearch(m, line('2026-11-12T08:00:00.000Z'));
  journalSearch(
    m,
    line(
      '2026-11-12T08:10:00.000Z',
      {},
      { query: QUERY, machines: [searched('host-a', 0)], total: 0 },
    ),
  );
  appendFileSync(searchJournalPath(m), 'torn\n');
  const there = {
    ...line('2026-11-12T08:05:00.000Z', { caller: 'host-b:agent-c', dir: '/w/web' }),
    machine: 'host-b',
  };
  const runPeer: PeerRunner = async (_m, machine) =>
    machine === 'host-b'
      ? {
          code: 0,
          stdout: JSON.stringify({
            since: '2026-11-05T00:00:00.000Z',
            until: null,
            machines: [{ machine: 'host-b', status: 'read', searches: 1, unreadable: 0 }],
            entries: [there],
          }),
          stderr: '',
          transportFailed: false,
          delivery: 'received',
        }
      : {
          code: 255,
          stdout: '',
          stderr: '',
          transportFailed: true,
          delivery: 'not-sent',
          failureDetail: 'no route',
        };
  const report = await searchReport(
    m,
    { since: Date.parse('2026-11-05T00:00:00.000Z'), until: null, machines: null },
    runPeer,
  );
  expect(report.entries.map((entry) => [entry.machine, entry.caller])).toEqual([
    ['host-a', 'host-a:agent-a'],
    ['host-b', 'host-b:agent-c'],
    ['host-a', 'host-a:agent-a'],
  ]);
  expect(report.machines).toEqual([
    { machine: 'host-a', status: 'read', searches: 2, unreadable: 1 },
    { machine: 'host-b', status: 'read', searches: 1, unreadable: 0 },
    { machine: 'host-c', status: 'unavailable', error: 'no route' },
  ]);
  const text = reportLines(report, Date.parse('2026-11-12T09:00:00.000Z'), 20).join('\n');
  expect(text).toContain(
    '3 search(es) since 2026-11-05T00:00:00.000Z — journals of host-a, host-b — lines 3',
  );
  expect(text).toContain('found nothing: 1 (33%)');
  expect(text).toContain('time: median 1.5s, p95 1.5s, longest 1.5s');
  expect(text).toMatch(/host-a:agent-a\s+2\s+1\s+50m/);
  expect(text).toContain('journal lines that could not be read: 1 on host-a');
  expect(text).toContain('NOT READ: host-c — no route');
  // The median of an even count is its lower middle value: a time some search actually took.
  const two = {
    ...report,
    entries: [
      { ...there, elapsedMs: 1000 },
      { ...there, elapsedMs: 3000 },
    ],
  };
  expect(reportLines(two, Date.now(), 20).join('\n')).toContain(
    'time: median 1.0s, p95 3.0s, longest 3.0s',
  );
});

test('a report reads only what a report is about', () => {
  const now = Date.parse('2026-11-12T09:00:00.000Z');
  const plain = parseSearchReport(['--report'], now);
  expect([plain.since, plain.until, plain.machines, plain.newest]).toEqual([
    now - 7 * 86_400_000,
    null,
    null,
    20,
  ]);
  expect(parseSearchReport(['--report', '--local', '--limit', '5'], now)).toMatchObject({
    machines: [],
    newest: 5,
  });
  expect(() => parseSearchReport(['--report', 'rollback'], now)).toThrow('takes no PATTERN');
  expect(() => parseSearchReport(['--report', '--role', 'user'], now)).toThrow(
    '--role is about a search',
  );
});
