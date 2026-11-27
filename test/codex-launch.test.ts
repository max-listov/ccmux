import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkRolloutIdsForMarker, rolloutIdsForMarker } from '../src/agent/codex/correlation.ts';
import {
  buildAdoptArgv,
  buildArgv,
  buildForkArgv,
  launchEnv,
  launchInputs,
} from '../src/agent/codex/launch.ts';
import { ownedCodexArgv } from '../src/agent/codex/owned/launch.ts';
import { codexProfile } from '../src/agent/codex/profileRoot.ts';
import { codexHistoryPresent, historyFile } from '../src/agent/codex/resume.ts';
import { makeMachine, makeSession } from './helpers.ts';

const tempDirs: string[] = [];
const makeTemp = (prefix = 'stitchmux-codex-'): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const codexMachine = (over: Record<string, unknown> = {}) =>
  makeMachine({ codexBin: '/opt/codex/codex', ...over });

test('first launch injects the management prompt as the positional PROMPT (no --session-id exists)', () => {
  const argv = buildArgv(
    makeSession({ agent: 'codex', name: 'cc-api' }),
    codexMachine(),
    'stitchmux',
    false,
  );
  expect(argv[0]).toBe('/opt/codex/codex');
  expect(argv).not.toContain('resume');
  // the prompt is the trailing positional and carries stitchmux's management instructions + the name
  const prompt = argv[argv.length - 1] ?? '';
  expect(prompt).toContain('managed by stitchmux');
  expect(prompt).toContain('cc-api');
});

test('resume launches `codex resume <uuid>` and NEVER re-injects the prompt', () => {
  const s = makeSession({ agent: 'codex', uuid: 'abcdef01-1111-4111-8111-111111111111' });
  const argv = buildArgv(s, codexMachine(), 'stitchmux', true);
  expect(argv.slice(0, 3)).toEqual(['/opt/codex/codex', 'resume', s.uuid]);
  expect(argv.some((a) => a.includes('managed by stitchmux'))).toBe(false);
});

test('adopt bootstrap resumes the exact source without a synthetic prompt', () => {
  const s = makeSession({ agent: 'codex' });
  const source = 'abcdef01-1111-4111-8111-111111111111';
  const argv = buildAdoptArgv(s, codexMachine(), source);
  expect(argv.slice(0, 3)).toEqual(['/opt/codex/codex', 'resume', source]);
  expect(argv.some((arg) => arg.includes('managed by stitchmux'))).toBe(false);
});

test('fork bootstrap uses provider-native fork and prompts only the new identity', () => {
  const s = makeSession({ agent: 'codex', name: 'cc-fork' });
  const source = 'abcdef01-1111-4111-8111-111111111111';
  const marker = 'stitchmux_33333333-3333-4333-8333-333333333333';
  const argv = buildForkArgv(s, codexMachine(), source, 'stitchmux', marker);
  expect(argv.slice(0, 3)).toEqual(['/opt/codex/codex', 'fork', source]);
  expect(argv.at(-1)).toContain('managed by stitchmux');
  expect(argv.at(-1)).toContain('cc-fork');
  expect(argv.at(-1)).toContain(marker);
});

test('flags survive verbatim, extraFlags come after session flags', () => {
  const s = makeSession({ agent: 'codex', flags: ['-m', 'gpt-5.6-sol'] });
  const argv = buildArgv(s, codexMachine({ extraFlags: ['--search'] }), 'stitchmux', true);
  expect(argv).toContain('gpt-5.6-sol');
  expect(argv.indexOf('-m')).toBeLessThan(argv.indexOf('--search'));
});

// ── exact launch correlation ───────────────────────────────────────────────────────────

function rollout(root: string, ymd: string, id: string, cwd: string, originator: string): void {
  const dir = join(root, ymd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-30T00-00-00-${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd, originator } })}\n`,
  );
}

function forkRollout(root: string, id: string, originator: string, sourceThreadId: string): void {
  const dir = join(root, '2026/08/10');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-10T00-00-00-${id}.jsonl`);
  const meta = JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd: '/home/user', originator: 'Codex Desktop', forked_from_id: sourceThreadId },
  });
  const prompt = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `stitchmux launch correlation: ${originator}` }],
    },
  });
  const largePrelude = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'x'.repeat(600 * 1024) }],
    },
  });
  const inheritedRecords = Array.from({ length: 80 }, (_item, index) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `inherited-${index}` }],
      },
    }),
  );
  writeFileSync(path, `${meta}\n${largePrelude}\n${inheritedRecords.join('\n')}\n${prompt}\n`);
}

const CODEX_ID = '019f7a53-8aa1-7e63-bc1d-5d2c9fdbb236';

test('correlation selects only the exact persisted launch marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-codex-'));
  rollout(
    root,
    '2026/07/30',
    CODEX_ID,
    '/home/user',
    'stitchmux_11111111-1111-4111-8111-111111111111',
  );
  rollout(root, '2026/07/30', 'aaaaaaaa-1111-4111-8111-111111111111', '/home/user', 'codex_cli_rs');
  const m = codexMachine({ codexSessionsDir: root });
  expect(rolloutIdsForMarker(m, 'stitchmux_11111111-1111-4111-8111-111111111111')).toEqual([
    CODEX_ID,
  ]);
});

test('correlation never uses cwd and exposes ambiguity instead of choosing newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-codex-'));
  const marker = 'stitchmux_11111111-1111-4111-8111-111111111111';
  rollout(root, '2026/07/30', CODEX_ID, '/somewhere/else', marker);
  rollout(root, '2026/07/31', 'aaaaaaaa-1111-4111-8111-111111111111', '/home/user', marker);
  const m = codexMachine({ codexSessionsDir: root });
  expect(rolloutIdsForMarker(m, marker)).toEqual(
    expect.arrayContaining([CODEX_ID, 'aaaaaaaa-1111-4111-8111-111111111111']),
  );
  expect(rolloutIdsForMarker(m, marker)).toHaveLength(2);
});

test('fork correlation requires both exact launch marker and provider-recorded parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchmux-codex-fork-'));
  const marker = 'stitchmux_11111111-1111-4111-8111-111111111111';
  const source = 'aaaaaaaa-1111-4111-8111-111111111111';
  forkRollout(root, CODEX_ID, marker, source);
  forkRollout(
    root,
    'bbbbbbbb-1111-4111-8111-111111111111',
    marker,
    'cccccccc-1111-4111-8111-111111111111',
  );
  const m = codexMachine({ codexSessionsDir: root });
  expect(forkRolloutIdsForMarker(m, marker, source)).toEqual([CODEX_ID]);
});

test('ready Codex identity resolves its exact rollout', () => {
  const root = makeTemp();
  rollout(
    root,
    '2026/07/30',
    CODEX_ID,
    '/home/user',
    'stitchmux_11111111-1111-4111-8111-111111111111',
  );
  const s = makeSession({ agent: 'codex', dir: '/home/user', uuid: CODEX_ID });
  const m = codexMachine({ codexSessionsDir: root });
  expect(historyFile(s, m)).not.toBeNull();
});

// ── per-session CODEX_HOME profiles ────────────────────────────────────────────────────

function declareCodexProfile(codexHome: string): string {
  const file = join(makeTemp('stitchmux-codex-env-'), 'profile.env');
  writeFileSync(file, `CODEX_HOME=${codexHome}\n`);
  return file;
}

test('session CODEX_HOME overrides machine codexHome; machine codexHome remains the default', () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/inherited/foreign/codex';
  try {
    const machineHome = makeTemp('stitchmux-codex-default-');
    const secondHome = makeTemp('stitchmux-codex-second-');
    const m = codexMachine({
      codexHome: machineHome,
      codexSessionsDir: join(machineHome, 'sessions'),
    });
    const plain = makeSession({ agent: 'codex', name: 'agent-a' });
    const second = makeSession({
      agent: 'codex',
      name: 'agent-b',
      envFile: declareCodexProfile(secondHome),
    });

    expect(launchEnv(m, plain).CODEX_HOME).toBe(machineHome);
    expect(launchEnv(m, second).CODEX_HOME).toBe(secondHome);

    // Without a machine default, an inherited CODEX_HOME must not leak into undeclared sessions.
    const noDefault = codexMachine({ codexHome: undefined, codexSessionsDir: undefined });
    expect(launchEnv(noDefault, plain).CODEX_HOME).toBeUndefined();
    expect(launchEnv(noDefault, second).CODEX_HOME).toBe(secondHome);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('codexProfile routes launchInputs and rollout discovery to the session CODEX_HOME', () => {
  const machineHome = makeTemp('stitchmux-codex-default-');
  const secondHome = makeTemp('stitchmux-codex-second-');
  const m = codexMachine({
    codexHome: machineHome,
    codexSessionsDir: join(machineHome, 'sessions'),
  });
  const secondSessions = join(secondHome, 'sessions');
  rollout(
    secondSessions,
    '2026/11/25',
    CODEX_ID,
    '/work/app',
    'stitchmux_22222222-2222-4222-8222-222222222222',
  );
  const second = makeSession({
    agent: 'codex',
    name: 'agent-b',
    uuid: CODEX_ID,
    envFile: declareCodexProfile(secondHome),
  });
  const plain = makeSession({ agent: 'codex', name: 'agent-a', uuid: CODEX_ID });

  expect(codexProfile(second, m)).toEqual({
    configDir: secondHome,
    codexHome: secondHome,
    sessionsDir: secondSessions,
  });
  expect(launchInputs(second, m).flatMap((input) => input.paths)).toEqual([
    `${secondHome}/AGENTS.md`,
    `${secondHome}/config.toml`,
  ]);
  expect(codexHistoryPresent(second, m)).toBe(true);
  expect(historyFile(second, m)?.startsWith(secondSessions)).toBe(true);
  // Negative control: default-profile session does not see the second profile's rollout.
  expect(codexHistoryPresent(plain, m)).toBe(false);
  expect(historyFile(plain, m)).toBeNull();
});

test('two Codex profiles on one host launch app-server each with its own CODEX_HOME', async () => {
  const root = makeTemp('stitchmux-codex-two-');
  const homeA = join(root, 'codex-a');
  const homeB = join(root, 'codex-b');
  const stateDir = join(root, 'state');
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Fake codex binary: records the received CODEX_HOME and argv when invoked as `app-server`,
  // and writes a session_meta rollout into its own `$CODEX_HOME/sessions`.
  const fakeCodex = join(root, 'fake-codex');
  writeFileSync(
    fakeCodex,
    `#!/bin/sh
set -eu
mkdir -p "$CODEX_HOME/sessions/2026/11/25"
printf '%s\\n%s\\n' "$CODEX_HOME" "$*" > "$CODEX_HOME/observed.txt"
printf '{"type":"session_meta","payload":{"id":"%s","originator":"app-server"}}\\n' "$TEST_THREAD_ID" > "$CODEX_HOME/sessions/2026/11/25/rollout-2026-11-25T00-00-00-$TEST_THREAD_ID.jsonl"
`,
  );
  chmodSync(fakeCodex, 0o755);

  // Machine default points to homeA; session B overrides it with homeB via its profile envFile.
  const m = codexMachine({
    stateDir,
    codexBin: fakeCodex,
    codexHome: homeA,
    codexSessionsDir: join(homeA, 'sessions'),
  });
  const uuidA = '11111111-1111-4111-8111-111111111111';
  const uuidB = '22222222-2222-4222-8222-222222222222';
  const sessionA = makeSession({
    agent: 'codex',
    runtime: 'native',
    name: 'agent-a',
    uuid: uuidA,
    dir: root,
    envFile: declareCodexProfile(homeA),
  });
  const sessionB = makeSession({
    agent: 'codex',
    runtime: 'native',
    name: 'agent-b',
    uuid: uuidB,
    dir: root,
    envFile: declareCodexProfile(homeB),
  });

  const runServer = async (session: typeof sessionA) => {
    const proc = Bun.spawn(ownedCodexArgv(session, m, 'stitchmux'), {
      cwd: session.dir,
      env: { ...launchEnv(m, session), TEST_THREAD_ID: session.uuid },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  };
  await Promise.all([runServer(sessionA), runServer(sessionB)]);

  const observedA = readFileSync(join(homeA, 'observed.txt'), 'utf8').trim().split('\n');
  const observedB = readFileSync(join(homeB, 'observed.txt'), 'utf8').trim().split('\n');
  expect(observedA[0]).toBe(homeA);
  expect(observedA[1]).toContain('app-server');
  expect(observedB[0]).toBe(homeB);
  expect(observedB[1]).toContain('app-server');
  expect(historyFile(sessionA, m)?.startsWith(join(homeA, 'sessions'))).toBe(true);
  expect(historyFile(sessionB, m)?.startsWith(join(homeB, 'sessions'))).toBe(true);
});
