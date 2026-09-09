import { afterEach, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptJsonSchema } from '../src/config/schema.ts';
import { appendSession, loadSessions } from '../src/config/sessions.ts';
import { readExternalTranscript } from '../src/external/transcript.ts';
import { shellQuote } from '../src/util/shellQuote.ts';
import { makeMachine, makeSession } from './helpers.ts';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = `app/${THREAD}`;
const CLI = join(import.meta.dir, '..', 'src/cli.ts');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const record = (n: number) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: '2026-09-01T00:00:00.000Z',
    payload: {
      type: 'message',
      role: n % 2 ? 'user' : 'assistant',
      content: [{ type: 'output_text', text: `message ${n}` }],
    },
  });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-external-transcript-'));
  roots.push(root);
  const storage = join(root, 'sessions');
  const state = join(root, 'state');
  mkdirSync(storage);
  mkdirSync(state);
  const path = join(storage, `rollout-test-${THREAD}.jsonl`);
  const metadata = JSON.stringify({ type: 'session_meta', payload: { id: THREAD, cwd: root } });
  writeFileSync(
    path,
    `${metadata}\n${Array.from({ length: 10 }, (_, n) => record(n + 1)).join('\n')}\n`,
    { mode: 0o600 },
  );
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: state,
    projectsDir: join(root, 'claude'),
    codexSessionsDir: storage,
    externalInventory: true,
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(m));
  const env: Record<string, string | undefined> = {
    ...process.env,
    CCMUX_CONFIG: config,
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  async function cli(address = ADDRESS, args = ['--json', '--tail', '3']) {
    const proc = Bun.spawn([process.execPath, CLI, 'transcript', address, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }
  return { root, storage, path, m, config, env, cli, metadata };
}

test('exact app address reads stored Codex without acquiring a managed identity', async () => {
  const f = setup();
  for (const address of [ADDRESS, `host-a:${ADDRESS}`]) {
    const r = await f.cli(address);
    expect(r.stderr).toBe('');
    expect(r.code, r.stdout).toBe(0);
    const page = TranscriptJsonSchema.parse(JSON.parse(r.stdout));
    expect(page.session).toEqual({
      name: ADDRESS,
      uuid: THREAD,
      rc: `host-a:${ADDRESS}`,
      dir: f.root,
      machine: 'host-a',
    });
    expect(page.source).toMatchObject({
      available: true,
      kind: 'codex-jsonl',
      path: realpathSync(f.path),
      error: null,
    });
    expect(page.messages.map((message) => message.text)).toEqual([
      'message 8',
      'message 9',
      'message 10',
    ]);
    expect(page.messages.map((message) => message.seq)).toEqual([9, 10, 11]);
    expect(page.cursor.line).toBe(11);
    expect(page.window.firstLine).toBe(9);
  }
  expect(loadSessions(f.m)).toEqual([]);
  expect(existsSync(join(f.m.stateDir, 'sessions.jsonl'))).toBe(false);
});

test('external CLI retains forward cursor, backward pages, incomplete line and full last answer', async () => {
  const f = setup();
  appendFileSync(f.path, `${record(11)}\n${record(12)}`);
  const forward = await f.cli(ADDRESS, ['--json', '--cursor', '11']);
  expect(forward.code).toBe(0);
  const page = TranscriptJsonSchema.parse(JSON.parse(forward.stdout));
  expect(page.messages.map((m) => m.text)).toEqual(['message 11']);
  expect(page.cursor.line).toBe(12);
  appendFileSync(f.path, '\n');
  const next = await f.cli(ADDRESS, ['--json', '--cursor', String(page.cursor.line)]);
  expect(TranscriptJsonSchema.parse(JSON.parse(next.stdout)).messages.map((m) => m.text)).toEqual([
    'message 12',
  ]);
  const older = await f.cli(ADDRESS, ['--json', '--before', '9', '--limit', '2']);
  const history = TranscriptJsonSchema.parse(JSON.parse(older.stdout));
  expect(history.messages.map((m) => m.seq)).toEqual([7, 8]);
  expect(history.messages.map((m) => m.text)).toEqual(['message 6', 'message 7']);
  const last = await f.cli(ADDRESS, ['--last-message']);
  expect(last.code).toBe(0);
  expect(last.stdout).toBe('message 12\n');
});

test('remote machine prefix reaches the target CLI with exact app identity and options', async () => {
  const f = setup();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const remoteConfig = join(f.root, 'remote.json');
  writeFileSync(remoteConfig, JSON.stringify({ ...f.m, rcPrefix: 'host-b' }));
  writeFileSync(
    f.config,
    JSON.stringify({
      ...f.m,
      fleet: { 'host-b': 'alias-b' },
      codexSessionsDir: join(f.root, 'no-local-storage'),
    }),
  );
  const argv = join(f.root, 'ssh-argv');
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(argv)}\nfor arg do command=$arg; done\nexport CCMUX_CONFIG=${shellQuote(remoteConfig)}\nexec /bin/sh -c "$command"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'ccmux'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`,
    { mode: 0o700 },
  );
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const r = await f.cli(`host-b:${ADDRESS}`, ['--json', '--before', '9', '--limit', '2']);
  expect(r.stderr).toBe('');
  expect(r.code, r.stdout).toBe(0);
  const page = TranscriptJsonSchema.parse(JSON.parse(r.stdout));
  expect(page.session.machine).toBe('host-b');
  expect(page.session.rc).toBe(`host-b:${ADDRESS}`);
  expect(page.messages.map((m) => m.text)).toEqual(['message 6', 'message 7']);
  expect(readFileSync(argv, 'utf8')).toContain(
    `'transcript' '${ADDRESS}' '--json' '--before' '9' '--limit' '2'`,
  );
});

test('missing and unreadable external storage are unavailable, not an empty success', async () => {
  const f = setup();
  const missing = await f.cli(`app/${OTHER}`);
  expect(missing.code).toBe(1);
  const absent = TranscriptJsonSchema.parse(JSON.parse(missing.stdout));
  expect(absent.source).toMatchObject({ available: false, error: 'transcript file not found' });
  expect(absent.cursor.line).toBeNull();
  chmodSync(f.path, 0o666);
  const blocked = await f.cli();
  expect(blocked.code).toBe(1);
  const unreadable = TranscriptJsonSchema.parse(JSON.parse(blocked.stdout));
  expect(unreadable.source).toMatchObject({
    available: false,
    error: 'transcript file unreadable',
  });
  expect(unreadable.messages).toEqual([]);
  expect(unreadable.cursor.line).toBeNull();
});

test('CLI tail and backward limit are capped in absolute line space', async () => {
  const f = setup();
  writeFileSync(
    f.path,
    `${f.metadata}\n${Array.from({ length: 1100 }, (_, n) => record(n + 1)).join('\n')}\n`,
  );
  for (const args of [
    ['--json', '--tail', '5000'],
    ['--json', '--before', '1102', '--limit', '5000'],
  ]) {
    const r = await f.cli(ADDRESS, args);
    expect(r.code, r.stdout).toBe(0);
    const page = TranscriptJsonSchema.parse(JSON.parse(r.stdout));
    expect(page.messages).toHaveLength(1000);
    expect(page.window.firstLine).toBe(102);
    expect(page.cursor.line).toBe(1101);
    expect(page.messages[0]?.text).toBe('message 101');
  }
});

test('explicit inspection is independent of fleet scanning; invalid and ambiguous identities fail closed', async () => {
  const f = setup();
  expect((await f.cli('app/not-a-uuid')).code).toBe(1);
  expect(
    (await readExternalTranscript({ ...f.m, externalInventory: false }, THREAD, { tail: 3 })).read
      .available,
  ).toBe(true);
  writeFileSync(f.path, `${f.metadata.replace(THREAD, OTHER)}\n${record(1)}\n`);
  expect((await readExternalTranscript(f.m, THREAD, { tail: 3 })).read.available).toBe(false);
  writeFileSync(f.path, `${f.metadata}\n`);
  const empty = await readExternalTranscript(f.m, THREAD, { tail: 3 });
  expect(empty.read.available).toBe(true);
  expect(empty.read.messages).toEqual([]);
  writeFileSync(join(f.storage, `rollout-other-${THREAD}.jsonl`), `${f.metadata}\n`);
  expect((await readExternalTranscript(f.m, THREAD, { tail: 3 })).read.error).toBe(
    'transcript file unreadable',
  );
});

test('managed transcript remains readable only by its registered address', async () => {
  const f = setup();
  await appendSession(
    f.m,
    makeSession({ name: 'agent-a', uuid: THREAD, agent: 'codex', dir: f.root }),
  );
  const before = readFileSync(join(f.m.stateDir, 'sessions.jsonl'), 'utf8');
  const managed = await f.cli('agent-a');
  expect(managed.code).toBe(0);
  expect(
    TranscriptJsonSchema.parse(JSON.parse(managed.stdout)).messages.map((m) => m.text),
  ).toEqual(['message 8', 'message 9', 'message 10']);
  const external = await f.cli();
  expect(external.code).toBe(1);
  expect(external.stderr).toContain('managed session address');
  expect(readFileSync(join(f.m.stateDir, 'sessions.jsonl'), 'utf8')).toBe(before);
});

test('a thread the provider archived is still readable at the same address', async () => {
  // Codex MOVES a finished thread from `sessions/` into `archived_sessions/` beside it, and the
  // address does not change with it. Looking only in the live directory answered "transcript file
  // not found" about a conversation sitting one directory over — measured on this fleet, 215
  // archived against 61 live on one machine, so that answer was wrong far more often than right.
  const f = setup();
  const archived = join(f.root, 'archived_sessions');
  mkdirSync(archived);
  const path = join(archived, `rollout-test-${OTHER}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'session_meta', payload: { id: OTHER, cwd: f.root } })}\n${record(1)}\n${record(2)}\n`,
    { mode: 0o600 },
  );
  const { read, dir } = await readExternalTranscript(f.m, OTHER, { tail: 3 });
  expect(read.available).toBe(true);
  expect(read.path).toBe(realpathSync(path));
  expect(read.messages.length).toBe(2);
  expect(dir).toBe(f.root);
});

test('a live thread still wins over an archived file with the same identity', async () => {
  // Both directories can hold the same id for a moment. The live one is the current conversation,
  // and resolving to yesterday's copy would be a quieter wrong answer than not finding it at all.
  const f = setup();
  const archived = join(f.root, 'archived_sessions');
  mkdirSync(archived);
  writeFileSync(
    join(archived, `rollout-old-${THREAD}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD, cwd: f.root } })}\n${record(99)}\n`,
    { mode: 0o600 },
  );
  const { read } = await readExternalTranscript(f.m, THREAD, { tail: 3 });
  expect(read.available).toBe(true);
  expect(read.path).toContain('/sessions/');
  expect(read.path).not.toContain('archived_sessions');
});

test('an identity in neither directory is still reported as missing', async () => {
  const f = setup();
  mkdirSync(join(f.root, 'archived_sessions'));
  const { read } = await readExternalTranscript(f.m, OTHER, { tail: 3 });
  expect(read.available).toBe(false);
  expect(read.error).toBe('transcript file not found');
});
