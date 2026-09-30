import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  observationExecCount,
  observedPanes,
  observedProcessRoots,
} from '../src/monitoring/tmux.ts';
import { rememberAgentPane } from '../src/tmux/agentPane.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
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
      expect((await observedProcessRoots(m)).length).toBe(10);
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
