import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { buildBundle } from '../scripts/bundle.ts';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { lifecycleBlockPath } from '../src/config/paths.ts';
import { appendSession } from '../src/session/registry.ts';
import { makeMachine, makeSession, UUID } from './helpers.ts';

// The shipped supervisor and its real registry, filesystem guard and launch recipe. The executable
// records argv/env instead of calling a model; this tests resume admission without provider traffic.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-stopped-profile-')));
const bundle = join(root, 'ccmux.js');
beforeAll(async () => {
  expect(await buildBundle(bundle)).toBe(true);
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const LaunchSchema = z.object({
  argv: z.array(z.string()),
  configDir: z.string().nullable(),
  pid: z.number().int().positive(),
});

async function world() {
  const dir = mkdtempSync(join(root, 'project-'));
  const stateDir = join(dir, 'state');
  const profile = join(dir, 'profile');
  const projectsDir = join(dir, 'default-projects');
  for (const path of [stateDir, profile, projectsDir]) mkdirSync(path);
  const envFile = join(dir, 'profile.env');
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${profile}\n`);
  const probe = join(dir, 'launch.json');
  const claudeBin = join(dir, 'claude');
  writeFileSync(
    claudeBin,
    `#!${process.execPath}
import { renameSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(`${probe}.pending`)}, JSON.stringify({
  argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, pid: process.pid,
}));
renameSync(${JSON.stringify(`${probe}.pending`)}, ${JSON.stringify(probe)});
await Bun.sleep(15_000);
`,
  );
  chmodSync(claudeBin, 0o755);
  const tmuxBin = join(dir, 'tmux');
  writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  chmodSync(tmuxBin, 0o755);
  const m = makeMachine({ claudeBin, tmuxBin, projectsDir, stateDir, rcPrefix: 'host-a' });
  const s = makeSession({ name: 'agent-a', dir, uuid: UUID, envFile });
  await appendSession(m, s);
  const config = join(dir, 'machine.json');
  writeFileSync(config, JSON.stringify(m));
  const transcript = (projects: string): string => {
    const folder = join(projects, encodeDir(dir));
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${UUID}.jsonl`);
    writeFileSync(path, '{"type":"user","message":{"role":"user","content":"history"}}\n');
    return path;
  };
  const seen = () => {
    mkdirSync(join(stateDir, 'seen'), { recursive: true });
    writeFileSync(join(stateDir, 'seen', s.name), UUID);
  };
  const start = () => {
    const supervisor = Bun.spawn([process.execPath, '--no-env-file', bundle, '_run', s.name], {
      cwd: dir,
      env: { ...process.env, HOME: dir, CCMUX_CONFIG: config, CCMUX_STATE_DIR: stateDir },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    return supervisor;
  };
  const launched = () =>
    existsSync(probe) ? LaunchSchema.parse(JSON.parse(readFileSync(probe, 'utf8'))) : null;
  return { m, s, dir, profile, probe, transcript, seen, start, launched };
}

async function until(done: () => boolean): Promise<void> {
  for (const stop = Date.now() + 10_000; Date.now() < stop; ) {
    if (done()) return;
    await Bun.sleep(20);
  }
  expect(done()).toBe(true);
}

type World = Awaited<ReturnType<typeof world>>;
async function stop(w: World, supervisor: ReturnType<World['start']>): Promise<void> {
  if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
  await supervisor.exited;
  const launch = w.launched();
  if (launch !== null) {
    try {
      process.kill(launch.pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
}

test('a stopped session resumes history found only in its declared profile, with the same UUID', async () => {
  const w = await world();
  const history = w.transcript(join(w.profile, 'projects'));
  w.seen();
  const original = readFileSync(history, 'utf8');
  const supervisor = w.start();
  try {
    await until(() => w.launched() !== null || supervisor.exitCode !== null);
    expect(w.launched()?.configDir).toBe(w.profile);
    const argv = w.launched()?.argv ?? [];
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)).toEqual([
      '--resume',
      UUID,
    ]);
    expect(argv).not.toContain('--session-id');
    expect(readFileSync(history, 'utf8')).toBe(original);
    expect(existsSync(lifecycleBlockPath(w.m, w.s.name))).toBe(false);
    expect(existsSync(join(w.m.projectsDir, encodeDir(w.dir), `${UUID}.jsonl`))).toBe(false);
  } finally {
    await stop(w, supervisor);
  }
});

test('a new session with no history starts at its pinned UUID', async () => {
  const w = await world();
  const supervisor = w.start();
  try {
    await until(() => w.launched() !== null || supervisor.exitCode !== null);
    const argv = w.launched()?.argv ?? [];
    expect(argv.slice(argv.indexOf('--session-id'), argv.indexOf('--session-id') + 2)).toEqual([
      '--session-id',
      UUID,
    ]);
    expect(argv).not.toContain('--resume');
    expect(w.launched()?.configDir).toBe(w.profile);
    expect(existsSync(lifecycleBlockPath(w.m, w.s.name))).toBe(false);
  } finally {
    await stop(w, supervisor);
  }
});

async function blocked(w: World): Promise<string> {
  const supervisor = w.start();
  try {
    await until(() => supervisor.exitCode !== null || w.launched() !== null);
    expect(w.launched()).toBeNull();
    expect(supervisor.exitCode).toBe(1);
    expect(existsSync(lifecycleBlockPath(w.m, w.s.name))).toBe(true);
    const reason = await new Response(supervisor.stderr).text();
    expect(reason).toContain(
      `Searched projects roots: ${w.m.projectsDir}, ${join(w.profile, 'projects')}`,
    );
    expect(reason).toContain('Refusing to start a NEW conversation');
    return reason;
  } finally {
    await stop(w, supervisor);
  }
}

test('a conversation in another profile blocks the launch and names every searched root', async () => {
  const w = await world();
  const other = join(w.dir, 'other-profile');
  const otherEnv = join(w.dir, 'other.env');
  writeFileSync(otherEnv, `CLAUDE_CONFIG_DIR=${other}\n`);
  await appendSession(
    w.m,
    makeSession({
      name: 'agent-b',
      dir: w.dir,
      uuid: '22222222-2222-4222-8222-222222222222',
      envFile: otherEnv,
    }),
  );
  const history = w.transcript(join(other, 'projects'));
  const reason = await blocked(w);
  expect(reason).toContain(`— it is at ${history}`);
  expect(reason).toContain(join(other, 'projects'));
  expect(readFileSync(history, 'utf8')).toContain('history');
});

test('a previously seen conversation that disappeared blocks before the agent starts', async () => {
  const w = await world();
  w.seen();
  expect(await blocked(w)).toContain(
    `missing at ${join(w.profile, 'projects', encodeDir(w.dir), `${UUID}.jsonl`)}`,
  );
});

test('an unreadable projects root cannot be treated as a new conversation', async () => {
  const w = await world();
  writeFileSync(join(w.profile, 'projects'), 'not a directory');
  const reason = await blocked(w);
  expect(reason).toContain('cannot verify conversation');
  expect(reason).toContain('Search incomplete:');
  expect(reason).toContain('ENOTDIR');
  expect(reason).not.toContain('has a conversation');
});

test('a non-directory expected project path blocks before the agent starts', async () => {
  const w = await world();
  const projects = join(w.profile, 'projects');
  mkdirSync(projects);
  writeFileSync(join(projects, encodeDir(w.dir)), 'not a directory');
  const reason = await blocked(w);
  expect(reason).toContain('cannot verify conversation');
  expect(reason).toContain('Search incomplete:');
  expect(reason).toContain('ENOTDIR');
});

for (const seen of [false, true]) {
  test.skipIf(process.getuid?.() === 0)(
    `an inaccessible expected transcript refuses without claiming absence (seen=${seen})`,
    async () => {
      const w = await world();
      const history = w.transcript(join(w.profile, 'projects'));
      const directory = dirname(history);
      const mode = statSync(directory).mode & 0o777;
      if (seen) w.seen();
      chmodSync(directory, 0);
      try {
        const reason = await blocked(w);
        expect(reason).toContain('cannot verify conversation');
        expect(reason).toContain('Search incomplete:');
        expect(reason).toContain(history);
        expect(reason).toContain('EACCES');
      } finally {
        chmodSync(directory, mode);
      }
    },
  );
}
