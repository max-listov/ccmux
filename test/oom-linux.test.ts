import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { observedProcessRoots, observedSessionInventory } from '../src/monitoring/tmux.ts';
import { applyOomPriority, oomPlan, procOomAccess } from '../src/runtime/oomPriority.ts';
import { readProcTable } from '../src/runtime/procTable.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { makeMachine } from './helpers.ts';

const Pids = z.object({ agent: z.number(), build: z.number(), browser: z.number() });
// Linux integration needs CAP_SYS_RESOURCE (bit 24); root in a container may also lack it.
const canLowerOom =
  process.platform === 'linux' &&
  (BigInt(
    `0x${readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s+([0-9a-f]+)/m)?.[1] ?? '0'}`,
  ) &
    (1n << 24n)) !==
    0n;

test.skipIf(process.platform !== 'linux' || !Bun.which('python3'))(
  'a real worker-thread fork is found without OOM privileges; the main task alone misses it',
  async () => {
    const python = Bun.which('python3');
    if (!python) throw new Error('python3');
    const child = Bun.spawn(
      [
        python,
        '-c',
        `import threading, subprocess, time, json, os
def worker():
    child = subprocess.Popen(['sleep', '600'])
    print(json.dumps({'parent': os.getpid(), 'child': child.pid}), flush=True)
    child.wait()
threading.Thread(target=worker).start()
time.sleep(600)
`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let descendant: number | null = null;
    try {
      const reader = child.stdout.getReader();
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(5000).then(() => {
          throw new Error('worker did not fork');
        }),
      ]);
      reader.releaseLock();
      const pids = z
        .object({ parent: z.number().int(), child: z.number().int() })
        .parse(JSON.parse(new TextDecoder().decode(chunk.value)));
      descendant = pids.child;
      expect(pids.parent).toBe(child.pid);
      const main = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
        .split(/\s+/)
        .map(Number);
      expect(main).not.toContain(pids.child);
      const table = readProcTable([child.pid]);
      expect(table.rows.find((row) => row.pid === pids.child)?.parent).toBe(child.pid);
    } finally {
      if (descendant !== null)
        try {
          process.kill(descendant, 'SIGTERM');
        } catch {}
      child.kill('SIGTERM');
      await child.exited;
    }
  },
);

test.skipIf(!canLowerOom || !Bun.which('tmux'))(
  'Linux tmux spine is protected and a newly inherited tool is released; intentional browser adjustment survives',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-linux-oom-');
    const tmux = Bun.which('tmux');
    if (!tmux) throw new Error('tmux');
    const m = makeMachine({ tmuxBin: tmux, tmuxSocket: `ccmux-oom-${crypto.randomUUID()}` });
    const previous = readFileSync(`/proc/${process.pid}/oom_score_adj`, 'utf8');
    const agent = join(root, 'agent.js'),
      runner = join(root, 'ccmux.js'),
      ready = join(root, 'ready'),
      spawn = join(root, 'spawn'),
      pids = join(root, 'pids');
    mkdirSync(join(root, 'work'));
    writeFileSync(
      agent,
      `import {existsSync} from 'node:fs'; await Bun.write(${JSON.stringify(ready)},String(process.pid)); while(!existsSync(${JSON.stringify(spawn)}))await Bun.sleep(10); const build=Bun.spawn(['sleep','600']);const browser=Bun.spawn(['sleep','600']);await Bun.write('/proc/'+browser.pid+'/oom_score_adj','300');await Bun.write(${JSON.stringify(pids)},JSON.stringify({agent:process.pid,build:build.pid,browser:browser.pid}));await Bun.sleep(600000);`,
    );
    writeFileSync(
      runner,
      `const child=Bun.spawn([process.execPath,${JSON.stringify(agent)}]);await child.exited;`,
    );
    let children: number[] = [];
    const command = (...args: string[]) => {
      const r = Bun.spawnSync(tmuxArgv(m, ...args));
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    async function wait(path: string) {
      const until = Date.now() + 5000;
      while (!existsSync(path) && Date.now() < until) await Bun.sleep(10);
      if (!existsSync(path)) throw new Error('child fixture did not publish');
    }
    try {
      command('new-session', '-d', '-s', 'agent-a', process.execPath, runner, '_run', 'agent-a');
      await wait(ready);
      children.push(Number(readFileSync(ready, 'utf8')));
      writeFileSync(`/proc/${children[0]}/oom_score_adj`, '0');
      await observedSessionInventory(m);
      const first = readProcTable([process.pid, ...(observedProcessRoots(m) ?? [])]);
      const plan = oomPlan(first, process.pid);
      expect(plan.spine.length).toBe(4);
      applyOomPriority(plan, -300, procOomAccess(first.rows));
      for (const pid of plan.spine)
        expect(Number(readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8'))).toBeLessThanOrEqual(
          -300,
        );
      writeFileSync(spawn, 'go');
      await wait(pids);
      const created = Pids.parse(JSON.parse(readFileSync(pids, 'utf8')));
      children = [created.agent, created.build, created.browser];
      expect(readFileSync(`/proc/${created.build}/oom_score_adj`, 'utf8').trim()).toBe('-300');
      await observedSessionInventory(m);
      const next = readProcTable([process.pid, ...(observedProcessRoots(m) ?? [])]);
      expect(
        applyOomPriority(oomPlan(next, process.pid), -300, procOomAccess(next.rows)).released,
      ).toBeGreaterThanOrEqual(1);
      expect(readFileSync(`/proc/${created.build}/oom_score_adj`, 'utf8').trim()).toBe('0');
      expect(readFileSync(`/proc/${created.browser}/oom_score_adj`, 'utf8').trim()).toBe('300');
    } finally {
      writeFileSync(`/proc/${process.pid}/oom_score_adj`, previous);
      for (const pid of children)
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      Bun.spawnSync(tmuxArgv(m, 'kill-server'));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
