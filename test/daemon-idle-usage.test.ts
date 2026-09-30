import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDaemonBenchProvider } from '../scripts/daemonBenchProvider.ts';
import { histFile } from '../src/agent/claude/resume.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { makeMachine, makeSession } from './helpers.ts';

const record = (id: string, input: number) =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      id,
      role: 'assistant',
      model: 'model-a',
      content: [],
      usage: { input_tokens: input },
    },
  })}\n`;

test.skipIf(!Bun.which('tmux'))(
  'full daemon keeps prepared archive quiet and completes requested catch-up',
  async () => {
    const root = mkdtempSync('/tmp/ccmux-idle-daemon-');
    const tmux = Bun.which('tmux');
    if (!tmux) throw new Error('tmux required');
    const machine = makeMachine({
      rcPrefix: 'host-a',
      stateDir: root,
      projectsDir: join(root, 'projects'),
      tmuxBin: tmux,
      tmuxSocket: `ccmux-idle-${crypto.randomUUID()}`,
      claudeBin: '/usr/bin/false',
      codexBin: '/usr/bin/false',
      opencodeBin: '/usr/bin/false',
      codexHome: join(root, 'codex'),
      codexSessionsDir: join(root, 'codex', 'sessions'),
      autoUpdate: false,
      chatEnabled: false,
    });
    const externalId = crypto.randomUUID();
    const externalPath = join(root, 'codex', 'sessions', `rollout-test-${externalId}.jsonl`);
    mkdirSync(dirname(externalPath), { recursive: true });
    const externalRecord = (n: number) =>
      `${JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: 5, total_tokens: n + 5 } } } })}\n`;
    writeFileSync(
      externalPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: externalId, cwd: root } })}\n${externalRecord(20)}`,
      { mode: 0o600 },
    );
    const provider = createDaemonBenchProvider(machine.codexHome ?? '', [externalId]);
    const session = makeSession({ name: 'agent-a', dir: root, archived: true });
    const path = histFile(root, session.uuid, machine.projectsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Array.from({ length: 1200 }, (_, i) => record(`message-${i}`, 1)).join(''));
    await writeSessionsUnlocked(machine, [session]);
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(machine));
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'daemon'],
      {
        env: {
          ...process.env,
          CCMUX_CONFIG: config,
          CCMUX_RC_PREFIX: 'host-a',
          CCMUX_STATE_DIR: root,
          CCMUX_CACHE_DIR: join(root, 'cache'),
          CCMUX_DATA_DIR: join(root, 'data'),
        },
        stdout: 'ignore',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    );
    // Drain logs as the process runs, including the failure path.
    const errors = new Response(child.stderr).text();
    const client = createControlClient({ socket: controlSocket(machine), timeoutMs: 2000 });
    async function readReady(input = {}, address = 'host-a:agent-a') {
      const until = Date.now() + 12000;
      while (Date.now() < until) {
        try {
          const result = await client['usage.read']({ address, ...input });
          if (result.state === 'ready') return result;
        } catch (error) {
          if (child.exitCode !== null) throw error;
        }
        await Bun.sleep(50);
      }
      throw new Error('full daemon usage never became ready');
    }
    let log = '';
    try {
      const initial = await readReady();
      expect((await readReady({}, `host-a:app/${externalId}`)).self.values.inputTokens).toBe(20);
      const externalUntil = Date.now() + 5000;
      while ((await client['external.list']()).status !== 'live' && Date.now() < externalUntil)
        await Bun.sleep(20);
      expect((await client['external.list']()).sessions).toHaveLength(1);
      expect(initial.self.values.inputTokens).toBe(1200);
      // Direct readers may checkpoint WAL. Allow one inventory tick to observe that change.
      await Bun.sleep(250);
      // The daemon has its own cache root; the parent test's path helper uses its preload root.
      const files = Array.from(
        new Bun.Glob('*.sqlite').scanSync(join(root, 'cache', 'transcript-index')),
      );
      const actual = files[0];
      if (!actual) throw new Error('missing isolated transcript index');
      const database = join(root, 'cache', 'transcript-index', actual);
      const quiet = statSync(database, { bigint: true }).ctimeNs;
      const quietAll = files.map(
        (name) => statSync(join(root, 'cache', 'transcript-index', name), { bigint: true }).ctimeNs,
      );
      expect(files).toHaveLength(2);
      await Bun.sleep(650);
      expect(statSync(database, { bigint: true }).ctimeNs).toBe(quiet);
      expect(
        files.map(
          (name) =>
            statSync(join(root, 'cache', 'transcript-index', name), { bigint: true }).ctimeNs,
        ),
      ).toEqual(quietAll);

      // A cold requested window must finish even while the default inventory source is unchanged.
      const window = await readReady({
        query: { since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' },
      });
      expect(window.self.values.inputTokens).toBe(1200);
      expect(window.sourceCoverage?.complete).toBe(true);
      appendFileSync(path, record('message-0', 10));
      expect((await readReady()).self.values.inputTokens).toBe(1209);
      appendFileSync(externalPath, externalRecord(40));
      expect((await readReady({}, `host-a:app/${externalId}`)).self.values.inputTokens).toBe(40);
    } finally {
      child.kill('SIGTERM');
      await child.exited;
      log = await errors;
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
    if (child.exitCode !== 143) throw new Error(`daemon exit ${child.exitCode}: ${log}`);
  },
  30000,
);
