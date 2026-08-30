import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { histFile } from '../src/agent/claude/resume.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { readMonitoringStatus } from '../src/monitoring/read.ts';
import type { MonitoringSnapshot } from '../src/monitoring/schema.ts';
import { readMonitoringStatus as readNativeStatus } from '../src/monitoring-reader.ts';
import { makeMachine, makeSession } from './helpers.ts';

test.skipIf(!Bun.which('tmux'))(
  'real isolated daemon publishes lifecycle, rotation and restart without owning reader lifetimes',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-status-daemon-'));
    const socket = `ccmux-status-${crypto.randomUUID()}`;
    const tmux = Bun.which('tmux');
    if (!tmux) throw new Error('tmux unavailable');
    const machine = makeMachine({
      rcPrefix: 'host-a',
      stateDir: root,
      projectsDir: join(root, 'transcripts'),
      tmuxBin: tmux,
      tmuxSocket: socket,
      claudeBin: '/usr/bin/false',
      autoUpdate: false,
      chatEnabled: false,
      sessionEvents: false,
    });
    const a = makeSession({ name: 'agent-a', dir: root, archived: true });
    const b = makeSession({
      name: 'agent-b',
      agent: 'codex',
      uuid: '22222222-2222-4222-8222-222222222222',
      archived: true,
    });
    const history = histFile(a.dir, a.uuid, machine.projectsDir);
    mkdirSync(dirname(history), { recursive: true });
    const record = (model: string) =>
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model, content: 'private transcript body' },
      })}\n`;
    writeFileSync(history, record('model-a'));
    await writeSessionsUnlocked(machine, [a, b]);
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(machine));
    const previousConfig = process.env.CCMUX_CONFIG;
    const previousPrefix = process.env.CCMUX_RC_PREFIX;
    process.env.CCMUX_CONFIG = config;
    process.env.CCMUX_RC_PREFIX = 'host-a';
    const env = {
      ...process.env,
      CCMUX_CONFIG: config,
      CCMUX_STATE_DIR: root,
      CCMUX_DATA_DIR: join(root, 'data'),
      CCMUX_CACHE_DIR: join(root, 'cache'),
      CCMUX_RC_PREFIX: 'host-a',
      LANG: 'C',
      LC_ALL: 'C',
    };
    const start = () =>
      Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'daemon'], {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
      });
    const runTmux = (...args: string[]) =>
      Bun.spawnSync([tmux, '-L', socket, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const create = () =>
      expect(
        runTmux(
          'new-session',
          '-d',
          '-s',
          a.name,
          'sh',
          '-c',
          "printf 'esc to interrupt\\n'; exec sleep 60",
        ).exitCode,
      ).toBe(0);
    async function waitFor(
      matches: (snapshot: MonitoringSnapshot) => boolean,
    ): Promise<MonitoringSnapshot> {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const result = await readNativeStatus({ timeoutMs: 1000 });
        if (result.snapshot !== null && matches(result.snapshot)) return result.snapshot;
        await Bun.sleep(50);
      }
      throw new Error('snapshot condition not observed');
    }
    create();
    let daemon = start();
    try {
      const first = await waitFor((s) => s.sessions[0]?.model === 'model-a');
      expect(first.sessions[0]).toMatchObject({ state: 'working', uuid: a.uuid, agent: 'claude' });
      expect(first.sessions[1]).toMatchObject({ state: 'stopped', uuid: b.uuid, agent: 'codex' });
      expect(JSON.stringify(first)).not.toContain('private transcript body');
      writeFileSync(`${history}.next`, record('model-b'));
      renameSync(`${history}.next`, history);
      await waitFor((s) => s.sessions[0]?.model === 'model-b');
      expect(runTmux('kill-session', '-t', '=agent-a').exitCode).toBe(0);
      await waitFor((s) => s.sessions[0]?.state === 'stopped');
      create();
      await waitFor((s) => s.sessions[0]?.state === 'working');
      daemon.kill('SIGTERM');
      await daemon.exited;
      expect(readMonitoringStatus(machine).status).not.toBe('live');
      expect((await readNativeStatus()).status).not.toBe('live');
      expect(runTmux('has-session', '-t', '=agent-a').exitCode).toBe(0);
      daemon = start();
      const restarted = await waitFor((s) => s.generation !== first.generation);
      expect(restarted.sessions[0]?.uuid).toBe(a.uuid);
      const cancellation = new AbortController();
      const cancelled = readNativeStatus({ signal: cancellation.signal });
      cancellation.abort();
      expect((await cancelled).reason).toBe('cancelled');
      expect(runTmux('has-session', '-t', '=agent-a').exitCode).toBe(0);
      daemon.kill('SIGKILL');
      await daemon.exited;
      expect((await readNativeStatus()).reason).toBe('producer-stopped');
      expect(runTmux('has-session', '-t', '=agent-a').exitCode).toBe(0);
      daemon = start();
      await waitFor((s) => s.generation !== restarted.generation);
      await writeSessionsUnlocked(machine, [b]);
      const removed = await waitFor(
        (s) => s.sessions.length === 1 && s.sessions[0]?.name === b.name,
      );
      expect(runTmux('has-session', '-t', '=agent-a').exitCode).toBe(0);
      const migrated = { ...machine, stateDir: join(root, 'migrated-state') };
      mkdirSync(migrated.stateDir);
      await writeSessionsUnlocked(migrated, [b]);
      writeFileSync(config, JSON.stringify(migrated));
      const moved = await waitFor((s) => s.sequence > removed.sequence);
      expect(moved.generation).toBe(removed.generation);
      expect(existsSync(join(migrated.stateDir, 'monitoring-status.json'))).toBe(true);
      expect(moved.sessions.map((s) => s.uuid)).toEqual([b.uuid]);
      expect(runTmux('has-session', '-t', '=agent-a').exitCode).toBe(0);
    } finally {
      daemon.kill('SIGTERM');
      await daemon.exited;
      runTmux('kill-session', '-t', '=agent-a');
      if (previousConfig === undefined) delete process.env.CCMUX_CONFIG;
      else process.env.CCMUX_CONFIG = previousConfig;
      if (previousPrefix === undefined) delete process.env.CCMUX_RC_PREFIX;
      else process.env.CCMUX_RC_PREFIX = previousPrefix;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
