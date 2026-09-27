import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cliPrincipal, managedPeer } from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/ledger.ts';
import { anonymousRemoteWarning } from '../src/commands/messagePeers.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { communicationAuthorizationFile } from './communication-fixture.ts';
import { makeChatMessage, makeCli, makeSession } from './helpers.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const RECEIVE_FIXTURE = join(import.meta.dir, 'fixtures', 'receive-chat.ts');
const MSG_FIXTURE = join(import.meta.dir, 'fixtures', 'msg.ts');

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-identity-'));
  const configPath = join(stateDir, 'machine.json');
  const machine = MachineConfigSchema.parse({
    claudeBin: '/bin/claude',
    codexBin: '/bin/codex',
    tmuxBin: '/bin/tmux',
    projectsDir: '/tmp/claude',
    codexSessionsDir: '/tmp/codex',
    rcPrefix: 'host-a',
    stateDir,
    bootLabel: 'ccmux.service',
  });
  writeFileSync(configPath, JSON.stringify(machine));
  const target = makeSession({
    name: 'worker',
    agent: 'claude',
    uuid: randomUUID(),
    chatEnabled: true,
  });
  writeFileSync(sessionsPath(machine), `${JSON.stringify(target)}\n`);
  return { configPath, machine, target };
}

async function receive(
  configPath: string,
  envelope: string,
): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  delete env.CCMUX_SESSION;
  const processHandle = Bun.spawn(['bun', RECEIVE_FIXTURE], {
    env,
    stdin: new Response(envelope),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(processHandle.stdout).text();
  const stderr = await new Response(processHandle.stderr).text();
  return { code: await processHandle.exited, output: `${stdout}${stderr}` };
}

async function send(
  configPath: string,
  transport: 'ssh' | 'remote' | null,
  args: string[],
  senderEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  delete env.CCMUX_SESSION;
  delete env.CCMUX_CHAT_CREDENTIAL;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_APP_TOOLS_PIPE_PATH;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  Object.assign(env, senderEnv);
  if (transport === null) delete env.CCMUX_TEST_REMOTE_TRANSPORT;
  else env.CCMUX_TEST_REMOTE_TRANSPORT = transport;
  const processHandle = Bun.spawn(
    ['bun', MSG_FIXTURE, '--communication-authorization', communicationAuthorizationFile, ...args],
    {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const stdout = await new Response(processHandle.stdout).text();
  const stderr = await new Response(processHandle.stderr).text();
  return { code: await processHandle.exited, stdout, stderr };
}

// Spawns a real CLI process, so its cost is the machine's rather than the assertion's. Given room
// beyond the default budget because it lost that race under a loaded full-suite run while passing
// alone — a timeout that reports load as a defect teaches a reader to ignore the gate.
test('an anonymous msg invoked under ssh is delivered but loudly loses its return address', async () => {
  const { configPath, machine } = setup();
  const result = await send(configPath, 'ssh', ['worker', 'hello']);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('sent ccmux/cli@host-a');
  expect(result.stderr).toContain('warning');
  expect(result.stderr).toContain('cannot reply to the originating agent');
  expect(result.stderr).toContain('instead of invoking remote ccmux msg through ssh');
  expect(loadLedger(machine)).toHaveLength(1);
  expect(loadLedger(machine)[0]?.from).toEqual(cliPrincipal('host-a'));
}, 20_000);

test('an anonymous msg invoked through a remote adapter gets the same return-address warning', async () => {
  const { configPath, machine } = setup();
  const result = await send(configPath, 'remote', ['worker', 'hello']);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('sent ccmux/cli@host-a');
  expect(result.stderr).toContain('warning');
  expect(result.stderr).toContain(
    'instead of invoking remote ccmux msg through the remote adapter',
  );
  expect(loadLedger(machine)).toHaveLength(1);
});

test('a human using local cli gets no anonymous-ssh warning', async () => {
  const { configPath, machine } = setup();
  const result = await send(configPath, null, ['worker', 'hello']);

  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain('warning');
  expect(loadLedger(machine)).toHaveLength(1);
});

test('invalid or missing Desktop sender identity refuses before ledger admission', async () => {
  for (const senderEnv of [
    { CODEX_THREAD_ID: 'not-a-uuid' },
    { CODEX_THREAD_ID: '' },
    { CODEX_APP_TOOLS_PIPE_PATH: '/tmp/tools.sock' },
    { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
  ]) {
    const { configPath, machine } = setup();
    const result = await send(configPath, null, ['worker', 'must not send'], senderEnv);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('valid CODEX_THREAD_ID');
    expect(result.stdout).not.toContain('sent');
    expect(loadLedger(machine)).toHaveLength(0);
  }
});

test('a valid UUID without provider verification never falls back to CLI', async () => {
  const { configPath, machine } = setup();
  writeFileSync(configPath, JSON.stringify({ ...machine, codexHome: machine.stateDir }));
  const result = await send(configPath, null, ['worker', 'must not send'], {
    CODEX_THREAD_ID: randomUUID(),
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('[endpoint-absent]');
  expect(result.stderr).toContain('Required: a reachable provider-owned');
  expect(loadLedger(machine)).toHaveLength(0);
});

test('App sender pins the provider response and refuses a different thread before admission', async () => {
  const { configPath, machine } = setup();
  const senderId = randomUUID();
  let returnedId = senderId;
  const socketDir = join(machine.stateDir, 'app-server-control');
  mkdirSync(socketDir);
  writeFileSync(configPath, JSON.stringify({ ...machine, codexHome: machine.stateDir }));
  const requestSchema = z.object({
    id: z.number().optional(),
    method: z.string(),
    params: z.unknown(),
  });
  const server = Bun.serve({
    unix: join(socketDir, 'app-server-control.sock'),
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const request = requestSchema.parse(JSON.parse(String(data)));
        if (request.method === 'initialize')
          ws.send(JSON.stringify({ id: request.id, result: {} }));
        if (request.method === 'thread/read') {
          expect(request.params).toEqual({ threadId: senderId, includeTurns: false });
          ws.send(
            JSON.stringify({
              id: request.id,
              result: {
                thread: {
                  id: returnedId,
                  name: 'Verified sender',
                  source: 'appServer',
                  status: { type: 'active', activeFlags: [] },
                  canAcceptDirectInput: false,
                },
              },
            }),
          );
        }
      },
    },
  });
  try {
    const accepted = await send(configPath, null, ['worker', 'verified'], {
      CODEX_THREAD_ID: senderId,
    });
    expect(accepted.code).toBe(0);
    const ledger = loadLedger(machine);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.from).toMatchObject({
      kind: 'codex-app',
      threadId: senderId,
      name: 'Verified sender',
    });
    expect(accepted.stdout).toContain(ledger[0]?.id ?? 'missing-receipt');
    returnedId = randomUUID();
    const refused = await send(configPath, null, ['worker', 'wrong identity'], {
      CODEX_THREAD_ID: senderId,
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('different thread identity');
    expect(loadLedger(machine)).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

test('the warning predicate is exact to cli over an authenticated remote transport', () => {
  const { machine, target } = setup();
  const cli = cliPrincipal(machine.rcPrefix);
  expect(anonymousRemoteWarning(cli, 'ssh')).not.toBeNull();
  expect(anonymousRemoteWarning(cli, 'remote')).not.toBeNull();
  expect(anonymousRemoteWarning(cli, null)).toBeNull();
  expect(anonymousRemoteWarning(managedPeer(machine.rcPrefix, target), 'ssh')).toBeNull();
  expect(anonymousRemoteWarning(managedPeer(machine.rcPrefix, target), 'remote')).toBeNull();
});

test('transport receive accepts the exact provider+UUID endpoint once', async () => {
  const { configPath, machine, target } = setup();
  const envelope = makeChatMessage({
    id: randomUUID(),
    from: makeCli('host-b'),
    to: managedPeer(machine.rcPrefix, target),
  });
  expect((await receive(configPath, JSON.stringify(envelope))).code).toBe(0);
  expect((await receive(configPath, JSON.stringify(envelope))).code).toBe(0);
  expect(loadLedger(machine)).toHaveLength(1);
});

test('concurrent retries append one envelope exactly once', async () => {
  const { configPath, machine, target } = setup();
  const envelope = JSON.stringify(
    makeChatMessage({
      id: randomUUID(),
      from: makeCli('host-b'),
      to: managedPeer(machine.rcPrefix, target),
    }),
  );
  const results = await Promise.all(Array.from({ length: 8 }, () => receive(configPath, envelope)));
  expect(results.every((result) => result.code === 0)).toBe(true);
  expect(loadLedger(machine)).toHaveLength(1);
});

test('receiver rejects a local invocation even when it self-sets SSH_CONNECTION', async () => {
  const { configPath, machine, target } = setup();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  delete env.CCMUX_SESSION;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  env.SSH_CONNECTION = 'forged';
  const proc = Bun.spawn(['bun', CLI, '_chat-receive-v2'], {
    env,
    stdin: new Response(
      JSON.stringify(
        makeChatMessage({
          id: randomUUID(),
          from: makeCli('host-b'),
          to: managedPeer(machine.rcPrefix, target),
        }),
      ),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await proc.exited).toBe(1);
  expect(loadLedger(machine)).toHaveLength(0);
});

test('reusing the session name with another provider/thread rejects stale mail before append', async () => {
  const { configPath, machine, target } = setup();
  const stale = makeChatMessage({
    id: randomUUID(),
    from: makeCli('host-b'),
    to: managedPeer(machine.rcPrefix, target),
  });
  const replacement = makeSession({
    name: target.name,
    agent: 'codex',
    uuid: randomUUID(),
    chatEnabled: true,
  });
  writeFileSync(sessionsPath(machine), `${JSON.stringify(replacement)}\n`);
  const result = await receive(configPath, JSON.stringify(stale));
  expect(result.code).toBe(1);
  expect(result.output).toContain('provider mismatch');
  expect(loadLedger(machine)).toHaveLength(0);
});

test('v1/name-only transport shape fails before append', async () => {
  const { configPath, machine } = setup();
  const result = await receive(
    configPath,
    JSON.stringify({ id: randomUUID(), from: 'peer', to: 'worker', body: 'x' }),
  );
  expect(result.code).toBe(1);
  expect(result.output).toContain('invalid v2 envelope');
  expect(loadLedger(machine)).toHaveLength(0);
});

test('Desktop-native coordination does not write the managed v2 ledger', () => {
  const { machine } = setup();
  expect(loadLedger(machine)).toHaveLength(0);
  appendMessage(
    machine,
    makeChatMessage({
      from: makeCli('host-a'),
      to: { kind: 'owner' },
      body: 'only ccmux producers write here',
    }),
  );
  expect(loadLedger(machine)).toHaveLength(1);
});
