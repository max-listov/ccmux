import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSession } from '../src/config/sessions.ts';
import { killSession, newSession, tmuxArgv } from '../src/tmux/tmux.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * The exit code of a removal answers "is it off the registry", and nothing else.
 *
 * Both directions lied. A straggler process group threw out of `killSession`, the throw escaped
 * `cmdRm`, and a session that HAD been removed reported failure — with a slice of the built bundle
 * where the cause belonged. A consumer that has to decide whether a session is gone could not use
 * the code in either direction, and fell back to parsing the text.
 */

function fixture(label: string) {
  const tmuxBin = Bun.which('tmux');
  if (!tmuxBin) throw new Error('tmux is required for the removal verdict tests');
  const dir = mkdtempSync(join(tmpdir(), `ccmux-${label}-`));
  const m = makeMachine({
    stateDir: dir,
    tmuxBin,
    tmuxSocket: `ccmux-${label}-${process.pid}`,
  });
  return {
    m,
    dir,
    cleanup: () => {
      Bun.spawnSync(tmuxArgv(m, 'kill-server'), { stdout: 'ignore', stderr: 'ignore' });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a process group that outlives its session is reported, not thrown', async () => {
  const f = fixture('linger');
  try {
    // A child in the pane's process group that ignores the hangup: the tmux session dies and the
    // group does not. This is the branch that used to throw, and it is driven here rather than
    // reasoned about — the deadline is a parameter so the case costs a fraction of a second.
    await newSession(f.m, 'agent-a', f.dir, ['sh', '-c', 'trap "" HUP TERM; sleep 30 & sleep 30']);
    const outcome = await killSession(f.m, 'agent-a', 300);
    expect(outcome.killed).toBe(true);
    // The straggler is a number an operator can act on, not an exception the caller must survive.
    expect(outcome.lingering).toBeGreaterThan(1);
  } finally {
    f.cleanup();
  }
}, 30_000);

test('a session with nothing left behind reports no straggler', async () => {
  const f = fixture('clean');
  try {
    await newSession(f.m, 'agent-a', f.dir, ['sleep', '30']);
    expect(await killSession(f.m, 'agent-a', 5_000)).toEqual({ killed: true, lingering: null });
    // And a name tmux never knew is not a kill that succeeded.
    expect(await killSession(f.m, 'agent-b', 300)).toEqual({ killed: false, lingering: null });
  } finally {
    f.cleanup();
  }
}, 30_000);

test('rm answers with its exit code, and prints a cause rather than its own source', async () => {
  const f = fixture('rm-verdict');
  const configPath = join(f.dir, 'machine.json');
  writeFileSync(configPath, `${JSON.stringify(f.m)}\n`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  env.CCMUX_STATE_DIR = f.dir;
  env.CCMUX_CACHE_DIR = join(f.dir, 'cache');
  const rm = async (name: string) => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'rm', name], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };
  try {
    await appendSession(f.m, makeSession({ name: 'agent-a', dir: f.dir }));
    await newSession(f.m, 'agent-a', f.dir, ['sh', '-c', 'trap "" HUP TERM; sleep 30 & sleep 30']);
    // Removed AND leaving a straggler: the straggler is a line, the verdict is still zero, because
    // the question `rm` answers is whether the session is off the registry.
    const removed = await rm('agent-a');
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('removed agent-a');
    expect(removed.out).toMatch(/warning: process group \d+ from agent-a is still running/);
    // Not a stack, not a slice of the built bundle: those arrive with line numbers and pipes, and
    // they landed where a person was waiting for a cause.
    expect(`${removed.out}${removed.err}`).not.toContain('Bun.sleep');
    expect(removed.err).not.toMatch(/^\s*\d+ \|/m);
    // The most common mistake — a name that is not there — is the one that answered zero.
    const missing = await rm('agent-zzz');
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("'agent-zzz' not in");
  } finally {
    f.cleanup();
  }
}, 30_000);
