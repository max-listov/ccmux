import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient } from 'stitchkit';
import { z } from 'zod';
import { histFile } from '../src/agent/claude/resume.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlConnection } from '../src/control/transport/connection.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { peerReadContract } from '../src/fleet/peerReadContract.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { tmuxArgv } from '../src/tmux/argv.ts';
import { AGENT_PANE_OPTION } from '../src/tmux/paneInventory.ts';
import { makeMachine, makeSession } from './helpers.ts';

test.skipIf(!Bun.which('tmux'))(
  'full daemon delivers pane work, quiet tool, completion, prompt, interruption and exact agent death to the Unix reader',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-pane-freshness-');
    const tmux = Bun.which('tmux');
    if (!tmux) throw new Error('tmux');
    const m = makeMachine({
      stateDir: root,
      rcPrefix: 'host-a',
      projectsDir: join(root, 'projects'),
      tmuxBin: tmux,
      tmuxSocket: `ccmux-pane-${crypto.randomUUID()}`,
      claudeBin: '/usr/bin/false',
      codexBin: '/usr/bin/false',
      opencodeBin: '/usr/bin/false',
      codexHome: join(root, 'codex'),
      codexSessionsDir: join(root, 'codex', 'sessions'),
      chatEnabled: false,
      autoUpdate: false,
      ensureInterval: 3600,
    });
    const a = makeSession({ name: 'agent-a', dir: root }),
      b = makeSession({ name: 'agent-b', dir: root, uuid: crypto.randomUUID() });
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(m));
    const view = join(root, 'view');
    writeFileSync(view, '❯\n? for shortcuts');
    const paneProgram = join(root, 'pane.ts');
    writeFileSync(
      paneProgram,
      `import{readFileSync}from'node:fs';const tool=Bun.spawn(['sleep','600']);for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>{tool.kill();process.exit(0)});let prior='';for(;;){const next=readFileSync(Bun.argv[2],'utf8');if(next!==prior){process.stdout.write(${JSON.stringify('\u001b[2J\u001b[3J\u001b[H')}+next+${JSON.stringify('\n')});prior=next;}await Bun.sleep(20);}`,
    );
    const command = (...args: string[]) => {
      const result = Bun.spawnSync(tmuxArgv(m, ...args));
      if (result.exitCode) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const history = (s: typeof a) => {
      const path = histFile(root, s.uuid, m.projectsDir);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'synthetic turn' } })}\n`,
      );
      const old = new Date(Date.now() - 120000);
      utimesSync(path, old, old);
      return path;
    };
    history(a);
    history(b);
    await writeSessionsUnlocked(m, [a]);
    const pane = command(
      'new-session',
      '-d',
      '-s',
      a.name,
      '-P',
      '-F',
      '#{pane_id}',
      process.execPath,
      paneProgram,
      view,
    );
    command('set-option', '-t', `=${a.name}:`, AGENT_PANE_OPTION, pane);
    command('new-window', '-d', '-t', `=${a.name}:`, 'sleep', '600');
    const daemon = Bun.spawn(
      [process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'daemon'],
      {
        env: {
          ...process.env,
          CCMUX_CONFIG: config,
          CCMUX_RC_PREFIX: m.rcPrefix,
          CCMUX_STATE_DIR: root,
          CCMUX_CACHE_DIR: join(root, 'cache'),
          CCMUX_DATA_DIR: join(root, 'data'),
        },
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    const log = new Response(daemon.stderr).text();
    const client = createControlClient({ socket: controlSocket(m), timeoutMs: 1000 });
    const peerConnection = createControlConnection({ socket: controlSocket(m), timeoutMs: 1000 });
    const peer = createClient(peerReadContract, peerConnection.http);
    const peerAnswer = z.object({
      sessions: z.object({
        items: z.record(
          z.string(),
          z.object({ name: z.string(), state: z.string(), atPrompt: z.string().nullable() }),
        ),
      }),
    });
    async function state(name: string, expected: string) {
      const until = Date.now() + 10000;
      let last = 'no row';
      while (Date.now() < until) {
        try {
          const row = (await client['session.list']()).sessions.find(
            (row) => row.identity.session === name,
          );
          last = row?.state ?? 'missing';
          if (last === expected) {
            const answer = peerAnswer.parse(await peer.list({ known: [] }));
            const peerRow = Object.values(answer.sessions.items).find((item) => item.name === name);
            if (
              (expected === 'prompt' &&
                peerRow?.atPrompt !== null &&
                peerRow?.atPrompt !== undefined) ||
              peerRow?.state === expected
            )
              return row;
          }
        } catch {
          if (daemon.exitCode !== null) break;
        }
        await Bun.sleep(50);
      }
      const frame = Bun.spawnSync(
        tmuxArgv(
          m,
          'capture-pane',
          '-t',
          name === a.name ? pane : `=${name}:0.0`,
          '-p',
          '-S',
          '-40',
        ),
      ).stdout.toString();
      throw new Error(
        `${name}: expected ${expected}, observed ${last}; pane: ${frame}; lifecycle: ${readFileSync(join(root, 'status', `${name}.lifecycle.json`), 'utf8')}`,
      );
    }
    const lifecycle = (s: typeof a, state: 'working' | 'idle', event: string, ts = Date.now()) => {
      mkdirSync(join(root, 'status'), { recursive: true });
      writeFileSync(
        join(root, 'status', `${s.name}.lifecycle.json`),
        JSON.stringify({ state, event, ts }),
      );
    };
    try {
      await state(a.name, 'idle');
      const workStarted = performance.now();
      lifecycle(a, 'working', 'UserPromptSubmit', Date.now() - 90000);
      writeFileSync(view, '✳ Computing…\nesc to interrupt');
      await state(a.name, 'working');
      // The contract is "visible within an observation interval" (2 s). A change that lands just
      // after a pass starts is seen by the next one, so the honest bound is two intervals; the
      // margin is for a loaded host, not for a slower contract. 2.25 s failed on scheduling noise.
      expect(performance.now() - workStarted).toBeLessThan(2 * 2000 + 500);
      const quiet = readFileSync(histFile(root, a.uuid, m.projectsDir), 'utf8');
      await Bun.sleep(4500);
      expect((await state(a.name, 'working'))?.state).toBe('working');
      expect(readFileSync(histFile(root, a.uuid, m.projectsDir), 'utf8')).toBe(quiet);
      lifecycle(a, 'idle', 'Stop');
      writeFileSync(view, '❯\n? for shortcuts');
      await state(a.name, 'idle');
      writeFileSync(
        view,
        'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n2. No, exit',
      );
      await state(a.name, 'prompt');
      const secondView = join(root, 'second-view');
      writeFileSync(secondView, '❯\n? for shortcuts');
      const second = command(
        'new-session',
        '-d',
        '-s',
        b.name,
        '-P',
        '-F',
        '#{pane_id}',
        process.execPath,
        paneProgram,
        secondView,
      );
      command('set-option', '-t', `=${b.name}:`, AGENT_PANE_OPTION, second);
      lifecycle(b, 'working', 'UserPromptSubmit', Date.now() - 90000);
      await writeSessionsUnlocked(m, [a, b]);
      await state(b.name, 'idle');
      const until = Date.now() + 10000;
      while (
        Date.now() < until &&
        !readFileSync(join(root, 'status', `${b.name}.lifecycle.json`), 'utf8').includes(
          'ccmux:turn-closed',
        )
      )
        await Bun.sleep(50);
      expect(readFileSync(join(root, 'status', `${b.name}.lifecycle.json`), 'utf8')).toContain(
        'ccmux:turn-closed',
      );
      command('kill-pane', '-t', pane);
      const stopped = await state(a.name, 'stopped');
      expect(stopped?.state).toBe('stopped');
      expect(command('has-session', '-t', `=${a.name}`)).toBe('');
    } finally {
      await client.close();
      await peerConnection.close();
      daemon.kill('SIGTERM');
      await daemon.exited;
      command('kill-server');
      rmSync(root, { recursive: true, force: true });
      expect(await log).not.toContain('daemon resource failed');
    }
  },
  45000,
);
