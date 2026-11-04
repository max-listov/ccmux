import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHistoryPresent, historyFile } from '../src/agent/codex/resume.ts';
import {
  codexRolloutFiles,
  currentRolloutFile,
  parseRolloutName,
  uuidV7Time,
} from '../src/agent/codex/rolloutFiles.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { lifecycleBlockPath } from '../src/config/paths.ts';
import { appendSession } from '../src/session/registry.ts';
import { SessionSchema } from '../src/session/schema.ts';
import { makeMachine, makeSession } from './helpers.ts';

// Codex keeps one thread in several files once it is long (Desktop splits it) and compresses files it
// is done with (`.jsonl.zst`, the CLI does it to idle threads). The names below are the real shapes.

const T0 = Date.parse('2026-10-14T07:49:10.710Z');
const thread = Bun.randomUUIDv7('hex', T0);
const segment = Bun.randomUUIDv7('hex', T0 + 5 * 86_400_000);

test('a rollout name gives the thread, the segment and whether it is compressed', () => {
  expect(parseRolloutName(`rollout-2026-10-14T14-49-10-${thread}.jsonl`)).toEqual({
    thread,
    segment: null,
    compressed: false,
  });
  expect(parseRolloutName(`rollout-2026-10-19T09-46-46-${thread}_${segment}.jsonl.zst`)).toEqual({
    thread,
    segment,
    compressed: true,
  });
  expect(parseRolloutName(`rollout-x-${thread}.json`)).toBeNull();
  expect(parseRolloutName(`${thread}.jsonl`)).toBeNull();
  expect(uuidV7Time(thread)).toBe(T0);
  expect(uuidV7Time(crypto.randomUUID())).toBeNull();
});

function storage(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-rollouts-'));
  for (const [i, name] of files.entries()) {
    const dir = join(root, '2026', '10', String(14 + i));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, name),
      `${JSON.stringify({ type: 'session_meta', payload: { id: thread } })}\n`,
    );
  }
  return root;
}

test('a split thread is its files oldest first, and the current one is the newest uncompressed', () => {
  const root = storage([
    `rollout-b-${thread}_${segment}.jsonl`,
    `rollout-a-${thread}.jsonl.zst`,
    `rollout-c-${crypto.randomUUID()}.jsonl`,
  ]);
  const files = codexRolloutFiles(root, thread);
  expect(files.map((file) => [file.compressed, file.start])).toEqual([
    [true, T0],
    [false, T0 + 5 * 86_400_000],
  ]);
  expect(currentRolloutFile(files)?.path).toEndWith(`_${segment}.jsonl`);
  const s = makeSession({ agent: 'codex', uuid: thread });
  const m = makeMachine({ codexSessionsDir: root });
  expect(historyFile(s, m)).toEndWith(`_${segment}.jsonl`);
  expect(codexHistoryPresent(s, m)).toBe(true);
});

test('a thread Codex compressed whole has no current file but is still a conversation', () => {
  const root = storage([`rollout-a-${thread}.jsonl.zst`]);
  const s = makeSession({ agent: 'codex', uuid: thread });
  const m = makeMachine({ codexSessionsDir: root });
  expect(historyFile(s, m)).toBeNull();
  expect(codexHistoryPresent(s, m)).toBe(true);
  expect(codexHistoryPresent(makeSession({ agent: 'codex', uuid: crypto.randomUUID() }), m)).toBe(
    false,
  );
});

/** The supervisor itself: does it launch the agent, or block the session as "missing rollout"? */
async function supervise(rollouts: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-supervise-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const dir = join(root, 'project');
  mkdirSync(dir);
  const sessions = join(root, 'sessions');
  for (const name of rollouts) {
    mkdirSync(join(sessions, 'day'), { recursive: true });
    writeFileSync(join(sessions, 'day', name), Bun.zstdCompressSync('{}\n'));
  }
  const launches = join(root, 'launches');
  const codex = join(root, 'codex');
  writeFileSync(codex, `#!/bin/sh\necho started >> ${JSON.stringify(launches)}\nsleep 30\n`);
  chmodSync(codex, 0o755);
  const tmux = join(root, 'tmux');
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n');
  chmodSync(tmux, 0o755);
  const machine = MachineConfigSchema.parse({
    claudeBin: '/bin/false',
    codexBin: codex,
    codexSessionsDir: sessions,
    tmuxBin: tmux,
    projectsDir: join(root, 'projects'),
    rcPrefix: 'host-a',
    stateDir,
    bootLabel: 'ccmux.service',
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));
  await appendSession(
    machine,
    SessionSchema.parse({ name: 'agent-a', dir, agent: 'codex', uuid: thread }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = config;
  env.CCMUX_STATE_DIR = stateDir;
  env.HOME = root;
  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  const proc = Bun.spawn([process.execPath, '--no-env-file', cli, '_run', 'agent-a'], {
    env,
    cwd: dir,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const blocked = () => existsSync(lifecycleBlockPath(machine, 'agent-a'));
  const launched = () => existsSync(launches) && readFileSync(launches, 'utf8').includes('started');
  for (const stop = Date.now() + 15_000; Date.now() < stop && !blocked() && !launched(); )
    await Bun.sleep(50);
  const outcome = { launched: launched(), blocked: blocked() };
  proc.kill('SIGKILL');
  await proc.exited;
  return outcome;
}

test('the supervisor resumes a thread whose only file is compressed instead of blocking it', async () => {
  expect(await supervise([`rollout-a-${thread}.jsonl.zst`])).toEqual({
    launched: true,
    blocked: false,
  });
}, 60_000);

test('control: with no file at all the same supervisor blocks the session as missing', async () => {
  expect(await supervise([])).toEqual({ launched: false, blocked: true });
}, 60_000);

test('discovery lists a split thread once, at its current file; transcript counts the earlier one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-split-discovery-'));
  const sessions = join(root, 'sessions');
  mkdirSync(join(sessions, 'a'), { recursive: true });
  mkdirSync(join(sessions, 'b'), { recursive: true });
  const meta = `${JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: root } })}\n`;
  const said = `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now' }] },
  })}\n`;
  writeFileSync(join(sessions, 'a', `rollout-a-${thread}.jsonl`), meta, { mode: 0o600 });
  writeFileSync(join(sessions, 'b', `rollout-b-${thread}_${segment}.jsonl`), meta + said, {
    mode: 0o600,
  });
  const m = makeMachine({
    rcPrefix: 'host-a',
    stateDir: join(root, 'state'),
    codexSessionsDir: sessions,
    codexHome: root,
    projectsDir: join(root, 'claude'),
    externalInventory: true,
  });
  const { discoverCodex } = await import('../src/external/codex.ts');
  const found = discoverCodex(m).filter((s) => s.threadId === thread);
  expect(found).toHaveLength(1);
  expect(found[0]?.path).toEndWith(`_${segment}.jsonl`);
  const { readExternalTranscript } = await import('../src/external/transcript.ts');
  const { read } = await readExternalTranscript(
    m,
    { provider: 'codex', threadId: thread },
    { tail: 10 },
  );
  expect(read.available).toBe(true);
  expect(read.earlierFiles).toBe(1);
  expect(read.messages.map((message) => message.text)).toContain('now');
});
