import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider } from '../src/agent/index.ts';
import { readTranscriptFile } from '../src/agent/transcript/transcriptRead.ts';
import { searchQuery, searchSummary } from '../src/commands/transcriptSearch.ts';
import {
  compilePattern,
  SEARCH_BATCH_LINES,
  SearchPatternError,
  searchTranscript,
  type TranscriptQuery,
} from '../src/context/transcriptSearch.ts';
import type { TranscriptWindowOptions } from '../src/context/transcriptWindow.ts';

/**
 * A search owes three things, and each test here holds one of them against a real Claude transcript
 * read through the same window reader the command uses: it looks at the WHOLE history unless told
 * otherwise, it matches what the conversation said rather than the record's bookkeeping, and the line
 * it names is the line a later read will find.
 */
const L = (o: unknown): string => JSON.stringify(o);

const say = (uuid: string, text: string, role: 'user' | 'assistant' = 'assistant') =>
  L({
    type: role,
    uuid,
    timestamp: '2026-09-23T00:00:00.000Z',
    cwd: '/Users/u/project',
    message: { role, content: [{ type: 'text', text }] },
  });

// With a description, as agents write them: the call's `text` is then the description, and the
// command itself lives only in the arguments.
const call = (uuid: string, id: string, command: string) =>
  L({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-23T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run a command' } },
      ],
    },
  });

const result = (uuid: string, id: string, content: string) =>
  L({
    type: 'user',
    uuid,
    timestamp: '2026-09-23T00:00:02.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

const filler = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => say(`f${from + i}`, `routine line ${from + i}`));

async function searching<T>(
  lines: string[],
  run: (
    read: (window: TranscriptWindowOptions) => Promise<ReturnType<typeof readTranscriptFile>>,
  ) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-search-'));
  try {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    return await run(async (window) => readTranscriptFile(path, getProvider('claude'), window));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const query = (pattern: string, extra: Partial<TranscriptQuery> = {}): TranscriptQuery => ({
  pattern: compilePattern(pattern),
  limit: 50,
  ...extra,
});

test('a match at the very start of a long history is found, and the answer says the whole of it was read', async () => {
  // Far past the 200-line window a plain read returns and past two batch boundaries: the place the
  // hand-written `--tail 400` search on the fleet could not see, and could not say it had not seen.
  const lines = [
    say('first', 'the producer clock drifted'),
    ...filler(2 * SEARCH_BATCH_LINES + 500),
  ];
  await searching(lines, async (read) => {
    const found = await searchTranscript(read, query('producer clock'));
    expect(found.total).toBe(1);
    expect(found.matches[0]?.seq).toBe(1);
    expect(found.scanned).toEqual({ firstLine: 1, lastLine: lines.length, messages: lines.length });
    expect(searchSummary(found, 'host-a:agent-a')[0]).toBe(
      `1 match in ${lines.length} messages, lines 1–${lines.length} (whole history)`,
    );
  });
});

test('nothing found is said with the range that was looked at, and a narrowed range says so', async () => {
  const lines = filler(300);
  await searching(lines, async (read) => {
    const none = await searchTranscript(read, query('absent'));
    expect(none.total).toBe(0);
    expect(searchSummary(none, 'host-a:agent-a')).toEqual([
      'no matches in 300 messages, lines 1–300 (whole history)',
    ]);
    const narrowed = await searchTranscript(read, query('absent', { tail: 50 }));
    expect(searchSummary(narrowed, 'host-a:agent-a')[0]).toBe(
      'no matches in 50 messages, lines 251–300 (of 300)',
    );
  });
});

test('a pattern present only in ids, paths and timestamps matches nothing', async () => {
  // The fleet search regex-matched each record serialized whole, so it found the record's uuid, its
  // working directory and its own earlier commands. Each of those fields carries the needle here;
  // only the last message SAYS it — the positive control that the needle is findable at all.
  const lines = [
    say('needle-uuid', 'nothing to see', 'user'),
    L({
      type: 'assistant',
      uuid: 'u2',
      cwd: '/Users/u/needle',
      timestamp: '2026-09-23T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'still nothing' }] },
    }),
    say('u3', 'here is the needle'),
  ];
  await searching(lines, async (read) => {
    const found = await searchTranscript(read, query('needle'));
    expect(found.matches.map((match) => match.seq)).toEqual([3]);
  });
});

test("a tool call's arguments are searched as written, not as their JSON encoding", async () => {
  // The command has a backslash; in the serialized input it is doubled. A literal written against
  // the command must find it, and one written against the encoding must not.
  const lines = [call('u1', 'c1', "rg '0\\.3\\.7' CHANGELOG.md"), result('u2', 'c1', 'no hits')];
  await searching(lines, async (read) => {
    const written = await searchTranscript(read, {
      pattern: compilePattern("'0\\.3\\.7'", { fixed: true }),
      limit: 50,
    });
    expect(written.matches.map((match) => [match.seq, match.field, match.kind])).toEqual([
      [1, 'input', 'tool_call'],
    ]);
    const encoded = await searchTranscript(read, {
      pattern: compilePattern('0\\\\.3', { fixed: true }),
      limit: 50,
    });
    expect(encoded.total).toBe(0);
    const output = await searchTranscript(read, query('no hits'));
    expect(output.matches[0]?.field).toBe('output');
    expect(output.matches[0]?.toolName).toBe('Bash');
  });
});

test('the line a match names is the line a window read before it ends on', async () => {
  const lines = [...filler(700), say('target', 'the answer is 42'), ...filler(40, 700)];
  await searching(lines, async (read) => {
    const [match] = (await searchTranscript(read, query('answer is'))).matches;
    expect(match?.seq).toBe(701);
    const window = await read({ tail: 20, before: (match?.seq ?? 0) + 1, limit: 1 });
    expect(window.messages.map((message) => [message.seq, message.text])).toEqual([
      [701, 'the answer is 42'],
    ]);
  });
});

test('a tool result in a later batch than its call is still searched, at its own line', async () => {
  const lines = [
    ...filler(SEARCH_BATCH_LINES - 1),
    call('c', 'c1', 'bun test'),
    result('r', 'c1', 'the flaky failure'),
  ];
  await searching(lines, async (read) => {
    const found = await searchTranscript(read, query('flaky failure'));
    expect(found.matches.map((match) => [match.seq, match.kind])).toEqual([
      [SEARCH_BATCH_LINES + 1, 'tool_result'],
    ]);
  });
});

test('the newest matches are kept and the total counts every one', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => say(`m${i}`, `hit number ${i + 1}`));
  await searching(lines, async (read) => {
    const found = await searchTranscript(read, query('hit number', { limit: 5 }));
    expect(found.total).toBe(30);
    expect(found.matches.map((match) => match.seq)).toEqual([26, 27, 28, 29, 30]);
    expect(searchSummary(found, 'host-a:agent-a')[1]).toBe(
      'showing the newest 5; older ones: add --before 26, or raise --limit',
    );
  });
});

test('role and kind narrow the search, and an unknown value is refused by name', async () => {
  const lines = [
    say('u1', 'deploy now', 'user'),
    say('u2', 'deploy done'),
    call('u3', 'c1', 'deploy'),
  ];
  await searching(lines, async (read) => {
    const q = searchQuery({
      grep: 'deploy',
      fixed: false,
      caseMode: 'smart',
      roles: ['assistant'],
      kinds: ['message'],
    });
    expect((await searchTranscript(read, q)).matches.map((match) => match.seq)).toEqual([2]);
  });
  expect(() =>
    searchQuery({ grep: 'x', fixed: false, caseMode: 'smart', roles: [], kinds: ['tool'] }),
  ).toThrow(
    "unknown kind 'tool'; one of: message, tool_call, tool_result, thinking, image, event, unknown",
  );
});

test('case follows the pattern, and a pattern that cannot search is refused before reading', () => {
  expect(compilePattern('producer').flags).toContain('i');
  expect(compilePattern('Producer').flags).not.toContain('i');
  // An escape is not a capital the caller typed.
  expect(compilePattern('\\Sproducer').flags).toContain('i');
  expect(compilePattern('Producer', { caseMode: 'ignore' }).flags).toContain('i');
  expect(compilePattern('producer', { caseMode: 'sensitive' }).flags).not.toContain('i');
  expect(compilePattern('a.b', { fixed: true }).test('axb')).toBe(false);
  expect(() => compilePattern('')).toThrow(SearchPatternError);
  expect(() => compilePattern('x*')).toThrow('matches empty text');
  expect(() => compilePattern('(unclosed')).toThrow('use -F for a literal string');
});

test('a transcript that cannot be read is reported as such, not as an empty search', async () => {
  const found = await searchTranscript(
    async (window) =>
      readTranscriptFile('/nonexistent/session.jsonl', getProvider('claude'), window),
    query('anything'),
  );
  expect(found.read.available).toBe(false);
  expect(found.read.error).toBe('transcript file not found');
  expect(found.total).toBe(0);
});
