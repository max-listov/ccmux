import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPaneTarget, listAgentLiveness, openAuxWindow } from '../src/tmux/agentPane.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { capturePane, newSession, sendKeysLiteral, setOption } from '../src/tmux/tmux.ts';
import type { MachineConfig } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * The agent's pane is addressed by the id tmux gave it, on a real tmux server of the test's own.
 *
 * The case these hold: a session with a second window whose agent pane died. Addressed by index, the
 * agent's address resolved to the second window's pane — a letter for the agent typed into someone
 * else's terminal — and `has-session` kept calling the session alive, so nothing healed it.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function server(): { m: MachineConfig; dir: string } {
  const tmuxBin = Bun.which('tmux');
  if (!tmuxBin) throw new Error('tmux is required for the agent pane tests');
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-agent-pane-'));
  const m = makeMachine({
    stateDir: dir,
    tmuxBin,
    tmuxSocket: `ccmux-agent-pane-${process.pid}-${cleanups.length}`,
    rcPrefix: 'host-a',
  });
  cleanups.push(() => {
    Bun.spawnSync(tmuxArgv(m, 'kill-server'), { stdout: 'ignore', stderr: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  });
  return { m, dir };
}

const tmux = (m: MachineConfig, ...args: string[]): string =>
  Bun.spawnSync(tmuxArgv(m, ...args))
    .stdout.toString()
    .trim();

test('a dead agent pane is dead: nothing is typed into the window beside it, and heal sees it', async () => {
  const { m, dir } = server();
  await newSession(m, 'agent-a', dir, ['sleep', '300']);
  const agent = await agentPaneTarget(m, 'agent-a');
  expect(agent).toMatch(/^%\d+$/);
  const aux = await openAuxWindow(m, 'agent-a', dir);
  expect(aux.paneId).not.toBe(agent);
  // Opened detached: the agent's window is still the current one.
  expect(tmux(m, 'display-message', '-p', '-t', '=agent-a:', '#{pane_id}')).toBe(agent);
  expect((await listAgentLiveness(m)).live.has('agent-a')).toBe(true);

  tmux(m, 'kill-pane', '-t', agent);
  expect(tmux(m, 'has-session', '-t', '=agent-a') === '').toBe(true); // tmux still has the session
  const after = await listAgentLiveness(m);
  expect(after.live.has('agent-a')).toBe(false);
  expect(after.agentGone.has('agent-a')).toBe(true);
  expect(await sendKeysLiteral(m, 'agent-a', 'for the agent only')).toBe(false);
  await Bun.sleep(100);
  expect(tmux(m, 'capture-pane', '-p', '-t', aux.paneId)).not.toContain('for the agent only');
  expect(await capturePane(m, 'agent-a', 10)).toBe('');
});

test('session options reach the session', async () => {
  const { m, dir } = server();
  await newSession(m, 'agent-a', dir, ['sleep', '300']);
  await setOption(m, 'agent-a', 'history-limit', '12345');
  expect(tmux(m, 'show-options', '-v', '-t', '=agent-a:', 'history-limit')).toBe('12345');
});

test('a session created before the id was recorded is given it when it has one pane', async () => {
  const { m, dir } = server();
  tmux(m, 'new-session', '-d', '-s', 'agent-old', '-c', dir, '--', 'sleep', '300');
  const only = tmux(m, 'list-panes', '-t', '=agent-old', '-F', '#{pane_id}');
  expect(await agentPaneTarget(m, 'agent-old')).toBe(only);
  expect(tmux(m, 'show-options', '-v', '-t', '=agent-old:', '@ccmux-agent-pane')).toBe(only);
});

test('ccmux window opens beside a registered running session and declares where', async () => {
  const { m, dir } = server();
  await newSession(m, 'agent-a', dir, ['sleep', '300']);
  const configPath = join(dir, 'machine.json');
  writeFileSync(configPath, `${JSON.stringify(m)}\n`);
  writeFileSync(
    join(dir, 'sessions.jsonl'),
    `# v2\n${JSON.stringify(makeSession({ name: 'agent-a', dir }))}\n`,
  );
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
      env: { ...process.env, CCMUX_CONFIG: configPath, CCMUX_STATE_DIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  };
  const opened = await run('window', 'agent-a', '--json');
  expect(opened.code).toBe(0);
  const answer = JSON.parse(opened.out);
  expect(answer).toMatchObject({
    address: 'host-a:agent-a',
    tmux: { socket: m.tmuxSocket, session: 'agent-a' },
    lifetime: 'session',
  });
  expect(tmux(m, 'list-panes', '-s', '-t', '=agent-a', '-F', '#{pane_id}').split('\n')).toContain(
    answer.window.paneId,
  );
  expect((await run('window', 'agent-z')).code).toBe(3);
});
