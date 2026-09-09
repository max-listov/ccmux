import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlServer } from '../src/control/server.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { readSessionUsage } from '../src/usage/service.ts';
import { shellQuote } from '../src/util/shellQuote.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('usage travels the Unix control contract with exact managed and external addresses', async () => {
  const root = mkdtempSync('/tmp/ccmux-usage-control-');
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    projectsDir: join(root, 'projects'),
    codexSessionsDir: join(root, 'sessions'),
  });
  const s = makeSession({ name: 'agent-a', dir: root, agent: 'claude' });
  const history = join(m.projectsDir, encodeDir(root));
  mkdirSync(history, { recursive: true });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(
    join(history, `${s.uuid}.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'message-one',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: 'message-one',
        role: 'assistant',
        model: 'model-a',
        content: [{ type: 'text', text: 'private fixture not for usage output' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`,
  );
  await writeSessionsUnlocked(m, [s]);
  const id = crypto.randomUUID();
  const file = join(root, 'sessions', `rollout-2026-01-01-${id}.jsonl`);
  writeFileSync(
    file,
    `${[
      { type: 'session_meta', payload: { id, cwd: root } },
      {
        type: 'event_msg',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 25, output_tokens: 5, total_tokens: 30 } },
        },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n')}\n`,
  );
  const publisher = new ControlPublisher(m);
  const server = createControlServer(m, publisher);
  const client = createControlClient({ socket: controlSocket(m) });
  try {
    const cold = await client['usage.read']({ address: 'host-a:agent-a' });
    expect(cold.state).toBe('building');
    await readSessionUsage(m, 'host-a:agent-a', UsageQuerySchema.parse({}), true);
    const managed = await client['usage.read']({ address: 'host-a:agent-a' });
    expect(managed.self.values.inputTokens).toBe(10);
    expect(managed.self.values.outputTokens).toBe(5);
    expect(managed.identity).toEqual({ sessionId: s.uuid, nativeSessionId: s.uuid });
    expect(JSON.stringify(managed)).not.toContain('private fixture');
    expect(JSON.stringify(managed)).not.toContain(root);
    const external = await readSessionUsage(
      m,
      `host-a:app/${id}`,
      UsageQuerySchema.parse({}),
      true,
    );
    expect(external.source).toBe('readable');
    const read = await client['usage.read']({ address: `host-a:app/${id}` });
    expect(read.self.values.inputTokens).toBe(25);
    expect(read.address).toBe(`host-a:app/${id}`);
    expect(read.identity).toEqual({ sessionId: null, nativeSessionId: id });
    expect((await client['usage.list']({})).data[0]?.self.values.inputTokens).toBe(10);
    await expect(client['usage.read']({ address: 'host-b:agent-a' })).rejects.toBeDefined();
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(m));
    const cliPath = join(import.meta.dir, '../src/cli.ts');
    const cli = async (args: string[], file = config) => {
      const child = Bun.spawn([process.execPath, '--no-env-file', cliPath, 'usage', ...args], {
        env: {
          ...process.env,
          CCMUX_CONFIG: file,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { data: stdout ? JSON.parse(stdout) : null, stderr, code };
    };
    const local = await cli(['--json', `host-a:app/${id}`]);
    expect(local.code).toBe(0);
    expect(local.data.self.values.inputTokens).toBe(25);
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'bin', 'ccmux'),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-env-file ${shellQuote(cliPath)} "$@"\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(root, 'bin', 'ssh'),
      `#!/bin/sh\nfor arg do command=$arg; done\nexport CCMUX_CONFIG=${shellQuote(config)}\nexec /bin/sh -c "$command"\n`,
      { mode: 0o700 },
    );
    const origin = join(root, 'origin.json');
    writeFileSync(
      origin,
      JSON.stringify({ ...m, rcPrefix: 'host-origin', fleet: { 'host-a': 'alias-a' } }),
    );
    const remote = await cli(['--json', `host-a:app/${id}`, '--limit', '1'], origin);
    expect(remote.stderr).toBe('');
    expect(remote.code).toBe(0);
    expect(remote.data.address).toBe(`host-a:app/${id}`);
    expect(remote.data.self.values.inputTokens).toBe(25);
    writeFileSync(config, JSON.stringify({ ...m, fleet: { 'host-b': 'alias-b' } }));
    writeFileSync(join(root, 'bin', 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o700 });
    const fleet = await cli(['--fleet', '--json']);
    expect(fleet.code).toBe(2);
    expect(fleet.data.coverage).toBe('partial');
    expect(fleet.data.total).toBeNull();
    expect(fleet.data.machines[1].status).toBe('unavailable');
    rmSync(file);
    const missing = await client['usage.read']({ address: `host-a:app/${id}` });
    expect(missing.source).toBe('missing');
    expect(missing.state).toBe('stale');
    expect(missing.self.values.inputTokens).toBe(25);
    expect(missing.self.fieldCoverage.inputTokens).toBe('partial');
  } finally {
    await client.close();
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    rmSync(root, { recursive: true, force: true });
  }
});
