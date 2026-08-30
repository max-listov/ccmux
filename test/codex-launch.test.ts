import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkRolloutIdsForMarker, rolloutIdsForMarker } from '../src/agent/codex/correlation.ts';
import { buildAdoptArgv, buildArgv, buildForkArgv } from '../src/agent/codex/launch.ts';
import { historyFile } from '../src/agent/codex/resume.ts';
import { makeMachine, makeSession } from './helpers.ts';

const codexMachine = (over: Record<string, unknown> = {}) =>
  makeMachine({ codexBin: '/opt/codex/codex', ...over });

test('first launch injects the management prompt as the positional PROMPT (no --session-id exists)', () => {
  const argv = buildArgv(
    makeSession({ agent: 'codex', name: 'cc-api' }),
    codexMachine(),
    'ccmux',
    false,
  );
  expect(argv[0]).toBe('/opt/codex/codex');
  expect(argv).not.toContain('resume');
  // the prompt is the trailing positional and carries ccmux's management instructions + the name
  const prompt = argv[argv.length - 1] ?? '';
  expect(prompt).toContain('managed by ccmux');
  expect(prompt).toContain('cc-api');
});

test('resume launches `codex resume <uuid>` and NEVER re-injects the prompt', () => {
  const s = makeSession({ agent: 'codex', uuid: 'abcdef01-1111-4111-8111-111111111111' });
  const argv = buildArgv(s, codexMachine(), 'ccmux', true);
  expect(argv.slice(0, 3)).toEqual(['/opt/codex/codex', 'resume', s.uuid]);
  expect(argv.some((a) => a.includes('managed by ccmux'))).toBe(false);
});

test('adopt bootstrap resumes the exact source without a synthetic prompt', () => {
  const s = makeSession({ agent: 'codex' });
  const source = 'abcdef01-1111-4111-8111-111111111111';
  const argv = buildAdoptArgv(s, codexMachine(), source);
  expect(argv.slice(0, 3)).toEqual(['/opt/codex/codex', 'resume', source]);
  expect(argv.some((arg) => arg.includes('managed by ccmux'))).toBe(false);
});

test('fork bootstrap uses provider-native fork and prompts only the new identity', () => {
  const s = makeSession({ agent: 'codex', name: 'cc-fork' });
  const source = 'abcdef01-1111-4111-8111-111111111111';
  const marker = 'ccmux_33333333-3333-4333-8333-333333333333';
  const argv = buildForkArgv(s, codexMachine(), source, 'ccmux', marker);
  expect(argv.slice(0, 3)).toEqual(['/opt/codex/codex', 'fork', source]);
  expect(argv.at(-1)).toContain('managed by ccmux');
  expect(argv.at(-1)).toContain('cc-fork');
  expect(argv.at(-1)).toContain(marker);
});

test('flags survive verbatim, extraFlags come after session flags', () => {
  const s = makeSession({ agent: 'codex', flags: ['-m', 'gpt-5.6-sol'] });
  const argv = buildArgv(s, codexMachine({ extraFlags: ['--search'] }), 'ccmux', true);
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
      content: [{ type: 'input_text', text: `ccmux launch correlation: ${originator}` }],
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
  const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-'));
  rollout(root, '2026/07/30', CODEX_ID, '/home/user', 'ccmux_11111111-1111-4111-8111-111111111111');
  rollout(root, '2026/07/30', 'aaaaaaaa-1111-4111-8111-111111111111', '/home/user', 'codex_cli_rs');
  const m = codexMachine({ codexSessionsDir: root });
  expect(rolloutIdsForMarker(m, 'ccmux_11111111-1111-4111-8111-111111111111')).toEqual([CODEX_ID]);
});

test('correlation never uses cwd and exposes ambiguity instead of choosing newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-'));
  const marker = 'ccmux_11111111-1111-4111-8111-111111111111';
  rollout(root, '2026/07/30', CODEX_ID, '/somewhere/else', marker);
  rollout(root, '2026/07/31', 'aaaaaaaa-1111-4111-8111-111111111111', '/home/user', marker);
  const m = codexMachine({ codexSessionsDir: root });
  expect(rolloutIdsForMarker(m, marker)).toEqual(
    expect.arrayContaining([CODEX_ID, 'aaaaaaaa-1111-4111-8111-111111111111']),
  );
  expect(rolloutIdsForMarker(m, marker)).toHaveLength(2);
});

test('fork correlation requires both exact launch marker and provider-recorded parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-fork-'));
  const marker = 'ccmux_11111111-1111-4111-8111-111111111111';
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
  const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-'));
  rollout(root, '2026/07/30', CODEX_ID, '/home/user', 'ccmux_11111111-1111-4111-8111-111111111111');
  const s = makeSession({ agent: 'codex', dir: '/home/user', uuid: CODEX_ID });
  const m = codexMachine({ codexSessionsDir: root });
  expect(historyFile(s, m)).not.toBeNull();
});
