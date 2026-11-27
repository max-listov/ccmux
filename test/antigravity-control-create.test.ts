import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createControlClient } from '../src/control/transport/client.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { createDaemonLifecycle } from '../src/daemon/lifecycle.ts';
import { antigravityFixture } from './fixtures/antigravity.ts';
import { makeMachine } from './helpers.ts';

test.skipIf(!Bun.which('tmux'))(
  'create_session promotes ACP identity before native_items can read the new session',
  async () => {
    const f = antigravityFixture();
    const tmux = Bun.which('tmux');
    if (!tmux) throw new Error('tmux required');
    const socket = `ccmux-agy-${crypto.randomUUID()}`;
    const m = makeMachine({
      rcPrefix: 'host-a',
      stateDir: f.stateDir,
      projectsDir: join(f.dir, 'projects'),
      antigravityBin: f.binPath,
      antigravityDataDir: f.dataDir,
      tmuxBin: tmux,
      tmuxSocket: socket,
      claudeBin: '/bin/false',
      codexHome: join(f.dir, 'codex'),
      externalInventory: false,
      autoUpdate: false,
    });
    const config = join(f.dir, 'machine.json');
    await Bun.write(config, JSON.stringify(m));
    const env = {
      ...process.env,
      CCMUX_CONFIG: config,
      CCMUX_STATE_DIR: m.stateDir,
      CCMUX_RC_PREFIX: m.rcPrefix,
      CCMUX_CACHE_DIR: join(f.dir, 'cache'),
      CCMUX_DATA_DIR: join(f.dir, 'data'),
    };
    const cli = [process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts')];
    const daemon = Bun.spawn([...cli, 'daemon'], { env, stdout: 'ignore', stderr: 'pipe' });
    const diagnostics = new Response(daemon.stderr).text();
    const client = createControlClient({ socket: controlSocket(m), timeoutMs: 12_000 });
    try {
      const deadline = AbortSignal.timeout(5000);
      const lifecycle = createDaemonLifecycle(m);
      while (
        !(await lifecycle.runs()).some((run) => run.pid === daemon.pid && run.readyAt) &&
        daemon.exitCode === null
      ) {
        deadline.throwIfAborted();
        await Bun.sleep(20);
      }
      if (daemon.exitCode !== null) throw new Error(await diagnostics);
      const created = await client['session.create']({
        requestId: crypto.randomUUID(),
        name: 'agent-a',
        workspace: f.workspace,
        runtime: 'antigravity',
        mode: 'native',
      });
      const result = Bun.spawn(
        [
          ...cli,
          'control',
          'native_items',
          `--target:=${JSON.stringify(created.target)}`,
          '--json',
        ],
        { env, stdout: 'pipe', stderr: 'pipe', timeout: 8000 },
      );
      const [code, stdout, stderr] = await Promise.all([
        result.exited,
        new Response(result.stdout).text(),
        new Response(result.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`native_items exited ${code}: ${stderr} ${stdout}`);
      expect(created.nativeSession?.id).toBe('11111111-1111-4111-8111-111111111111');
      expect(created.target.threadId).not.toBe(created.nativeSession?.id);
      expect(JSON.parse(stdout)).toMatchObject({
        target: created.target,
        nativeId: created.nativeSession?.id,
        status: 'live',
      });
    } finally {
      await client.close();
      daemon.kill();
      await daemon.exited;
      Bun.spawnSync([tmux, '-L', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
  25_000,
);
