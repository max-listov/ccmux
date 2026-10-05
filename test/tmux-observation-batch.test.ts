import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  observedPanes,
  observedPeerPanes,
  observedProcessRoots,
  observedSessionInventory,
  processRoots,
} from '../src/monitoring/tmux.ts';
import { applyOomPriority, oomPlan } from '../src/runtime/oomPriority.ts';
import { producerMetrics } from '../src/util/producerMetrics.ts';

const observationExecCount = () => producerMetrics.snapshot().observation?.execCount ?? 0;

import { rememberAgentPane } from '../src/tmux/agentPane.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { capturePane } from '../src/tmux/tmux.ts';
import { makeMachine } from './helpers.ts';

test.skipIf(!Bun.which('tmux'))(
  'batch captures exact panes, reduces forks, and preserves surviving evidence on pane death',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-batch-');
    const tmux = Bun.which('tmux');
    if (!tmux) throw new Error('tmux');
    const m = makeMachine({
      stateDir: root,
      tmuxBin: tmux,
      tmuxSocket: `ccmux-batch-${crypto.randomUUID()}`,
    });
    const command = (...args: string[]) => {
      const r = Bun.spawnSync(tmuxArgv(m, ...args));
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    try {
      const names = Array.from({ length: 9 }, (_, i) => `agent-${i}`);
      for (const [i, name] of names.entries()) {
        const pane = command(
          'new-session',
          '-d',
          '-s',
          name,
          '-P',
          '-F',
          '#{pane_id}',
          'sh',
          '-c',
          `printf 'pane-${i}\\n'; exec sleep 600`,
        );
        rememberAgentPane(m, name, pane);
      }
      let captured = new Map<string, string | null>();
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        captured = await observedPanes(m, names);
        if (names.every((name, i) => captured.get(name)?.includes(`pane-${i}`))) break;
        await Bun.sleep(20);
      }
      for (const [i, name] of names.entries()) expect(captured.get(name)).toContain(`pane-${i}`);
      const before = observationExecCount();
      await observedPanes(m, names);
      expect(observationExecCount() - before).toBe(2);
      expect(observedProcessRoots(m)).toBeNull();
      const inventoryBefore = observationExecCount();
      await observedSessionInventory(m);
      expect(observationExecCount() - inventoryBefore).toBe(1);
      const freshRoots = observedProcessRoots(m) ?? [];
      expect(observedProcessRoots(m, Date.now() + 10_001)).toBeNull();
      const serverPid = Number(command('display-message', '-p', '#{pid}'));
      const runnerPid = freshRoots.find((pid) => pid !== serverPid);
      if (runnerPid === undefined) throw new Error('missing pane root');
      const agentPid = 800001,
        toolPid = 800002;
      const full = {
        rows: [
          { pid: process.pid, parent: 1 },
          { pid: serverPid, parent: 1 },
          { pid: runnerPid, parent: serverPid },
          { pid: agentPid, parent: runnerPid },
          { pid: toolPid, parent: agentPid },
        ],
        runners: [runnerPid],
      };
      const values = new Map([
        [process.pid, 0],
        [serverPid, 0],
        [runnerPid, 0],
        [agentPid, -300],
        [toolPid, -300],
      ]);
      const access = {
        read: (pid: number) => values.get(pid) ?? null,
        write: (pid: number, value: number) => {
          values.set(pid, value);
        },
      };
      const stale = observedProcessRoots(m, Date.now() + 10_001) ?? [];
      expect(observedProcessRoots(m, Date.now() + 10_001)).toBeNull();
      applyOomPriority(
        oomPlan(
          { rows: full.rows.filter((row) => row.pid === process.pid), runners: stale },
          process.pid,
        ),
        -300,
        access,
      );
      expect(values.get(process.pid)).toBe(-300);
      expect(values.get(toolPid)).toBe(-300);
      await observedSessionInventory(m);
      expect(observedProcessRoots(m)).toEqual(freshRoots);
      applyOomPriority(oomPlan(full, process.pid), -300, access);
      expect(values.get(toolPid)).toBe(0);
      expect(observedProcessRoots(m)?.length).toBe(10);
      expect(observationExecCount() - inventoryBefore).toBe(2);
      // A late inventory is replaced for the OOM pass, not read as "no roots".
      const refreshBefore = observationExecCount();
      expect(await processRoots(m, Date.now() + 10_001)).toEqual(freshRoots);
      expect(observationExecCount() - refreshBefore).toBe(1);
      command('kill-session', '-t', names[0] ?? '');
      const after = await observedPanes(m, names);
      expect(after.get(names[0] ?? '')).toBeNull();
      for (const [i, name] of names.entries())
        if (i) expect(after.get(name)).toContain(`pane-${i}`);
    } finally {
      Bun.spawnSync(tmuxArgv(m, 'kill-server'));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which('tmux'))(
  'peer scrollback equals capture -S -30 at different pane heights and excludes older working markers',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-peer-window-');
    const m = makeMachine({
      stateDir: root,
      tmuxBin: Bun.which('tmux') ?? '/usr/bin/tmux',
      tmuxSocket: `ccmux-window-${crypto.randomUUID()}`,
    });
    try {
      for (const height of [10, 24, 80]) {
        const name = `agent-${height}`;
        const history = Array.from({ length: 160 }, (_, i) =>
          i === 160 - height - 35 ? 'esc to interrupt' : `history ${i}`,
        ).join('\n');
        const content = `${history}\n───\n❯ \n? for shortcuts\n`;
        const r = Bun.spawnSync(
          tmuxArgv(
            m,
            'new-session',
            '-d',
            '-x',
            '120',
            '-y',
            String(height),
            '-s',
            name,
            '-P',
            '-F',
            '#{pane_id}',
            process.execPath,
            '-e',
            `process.stdout.write(${JSON.stringify(content)});await Bun.sleep(600000);`,
          ),
        );
        expect(r.exitCode).toBe(0);
        rememberAgentPane(m, name, r.stdout.toString().trim());
        let text: string | null | undefined;
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          text = (await observedPanes(m, [name])).get(name);
          if (text?.includes('? for shortcuts')) break;
          await Bun.sleep(20);
        }
        expect(text).toContain('esc to interrupt');
        await observedSessionInventory(m);
        const panes = await observedPanes(m, [name]);
        const warm = observedPeerPanes(m, panes).get(name);
        const cold = await capturePane(m, name, 30);
        expect(warm).toBe(cold);
        expect(warm).not.toContain('esc to interrupt');
      }
    } finally {
      Bun.spawnSync(tmuxArgv(m, 'kill-server'));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which('tmux'))(
  'a session restarted by another process is captured on the next pass, with one child per chunk',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-restart-');
    const m = makeMachine({
      stateDir: root,
      tmuxBin: Bun.which('tmux') ?? '/usr/bin/tmux',
      tmuxSocket: `ccmux-restart-${crypto.randomUUID()}`,
    });
    const command = (...args: string[]) => {
      const r = Bun.spawnSync(tmuxArgv(m, ...args));
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    // What `newSession` does: create the session and record its agent pane on the session.
    const start = (name: string, marker: string) => {
      const pane = command(
        'new-session',
        '-d',
        '-s',
        name,
        '-P',
        '-F',
        '#{pane_id}',
        'sh',
        '-c',
        `printf '${marker}\\n'; exec sleep 600`,
      );
      command('set-option', '-t', name, '@ccmux-agent-pane', pane);
      return pane;
    };
    const until = async (name: string, marker: string) => {
      const deadline = Date.now() + 5000;
      let text: string | null | undefined;
      while (Date.now() < deadline) {
        await observedSessionInventory(m);
        text = (await observedPanes(m, [name])).get(name);
        if (text?.includes(marker)) return text;
        await Bun.sleep(20);
      }
      return text;
    };
    try {
      // A live server outlives one session's restart, so the new pane gets a new id, as it does on a host.
      start('anchor', 'anchor');
      const old = start('agent-a', 'first-life');
      rememberAgentPane(m, 'agent-a', old);
      expect(await until('agent-a', 'first-life')).toContain('first-life');
      // Another process restarts the session: the daemon's cached pane id now names a dead pane.
      command('kill-session', '-t', 'agent-a');
      const fresh = start('agent-a', 'second-life');
      expect(fresh).not.toBe(old);
      expect(await until('agent-a', 'second-life')).toContain('second-life');
      await observedSessionInventory(m);
      const before = observationExecCount();
      const panes = await observedPanes(m, ['agent-a']);
      expect(panes.get('agent-a')).toContain('second-life');
      expect(observationExecCount() - before).toBe(1);
    } finally {
      Bun.spawnSync(tmuxArgv(m, 'kill-server'));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which('tmux'))(
  'a batch that misses its deadline is one child, not a serial retry of every pane',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-deadline-');
    const m = makeMachine({
      stateDir: root,
      tmuxBin: Bun.which('tmux') ?? '/usr/bin/tmux',
      tmuxSocket: `ccmux-deadline-${crypto.randomUUID()}`,
    });
    const names = Array.from({ length: 3 }, (_, i) => `agent-${i}`);
    const previous = process.env.CCMUX_OBSERVE_DEADLINE_MS;
    try {
      for (const name of names) {
        const r = Bun.spawnSync(
          tmuxArgv(m, 'new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', 'sleep', '600'),
        );
        rememberAgentPane(m, name, r.stdout.toString().trim());
      }
      process.env.CCMUX_OBSERVE_DEADLINE_MS = '0';
      const before = observationExecCount();
      const panes = await observedPanes(m, names);
      expect(observationExecCount() - before).toBe(1);
      for (const name of names) expect(panes.get(name)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CCMUX_OBSERVE_DEADLINE_MS;
      else process.env.CCMUX_OBSERVE_DEADLINE_MS = previous;
      Bun.spawnSync(tmuxArgv(m, 'kill-server'));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
