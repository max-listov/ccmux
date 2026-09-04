#!/usr/bin/env bun
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readCodexAppThread } from '../src/agent/codex/appServer.ts';
import { ownedCodexSocket } from '../src/agent/codex/ownedPaths.ts';
import { readOwnedCodexStatus } from '../src/agent/codex/ownedStatus.ts';
import { connectCodexSocket } from '../src/agent/codex/socket.ts';
import { loadMachineConfig } from '../src/config/machine.ts';
import { withSessionRegistryLock } from '../src/config/registryLock.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/config/sessions.ts';
import { killSession, newSession } from '../src/tmux/tmux.ts';

// Deliberately separate state and tmux socket; real provider authentication stays native.
// No production conversation is adopted, resumed, stopped or messaged by this probe.
const reuse = process.argv[2];
const root = reuse === undefined ? mkdtempSync('/tmp/ccmux-owned-probe-') : dirname(reuse);
if (!basename(root).startsWith('ccmux-owned-probe-'))
  throw new Error('Reuse requires an isolated owned-runtime probe directory');
const config = reuse ?? join(root, 'machine.json');
const work = process.cwd();
const machine = MachineConfigSchema.parse({
  ...(reuse === undefined
    ? loadMachineConfig()
    : MachineConfigSchema.parse(JSON.parse(readFileSync(config, 'utf8')))),
  stateDir: join(root, 'state'),
  rcPrefix: 'test',
  tmuxSocket: `ccmux-owned-${root.split('-').at(-1)}`,
  fleet: {},
  remoteTransport: { peers: [] },
  autoUpdate: false,
  chatEnabled: true,
  sessionEvents: true,
  remoteControl: false,
  codexCorrelationTimeoutMs: 45_000,
  telegram: undefined,
});
writeFileSync(config, JSON.stringify(machine), { mode: 0o600 });
const cli = process.argv[3] ?? join(work, 'src/cli.ts');
const env: Record<string, string> = {
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: machine.stateDir,
  CCMUX_CACHE_DIR: join(root, 'cache'),
  CCMUX_DATA_DIR: join(root, 'data'),
};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && env[key] === undefined) env[key] = value;
for (const key of [
  'CCMUX_SESSION',
  'CCMUX_CHAT_CREDENTIAL',
  'CODEX_THREAD_ID',
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
])
  delete env[key];

async function command(args: string[], timeout = 60_000): Promise<string> {
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), timeout);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(`${args[0]} exited ${exitCode}: ${stderr}\n${stdout}`);
  return stdout;
}

console.log(JSON.stringify({ root, config, phase: 'launch' }));
if (reuse !== undefined) {
  await killSession(machine, 'probe-daemon');
  await withSessionRegistryLock(machine, () =>
    writeSessionsUnlocked(
      machine,
      loadSessions(machine).map((s) => ({
        ...s,
        flags: [
          '--sandbox',
          'workspace-write',
          '--ask-for-approval',
          'on-request',
          '--no-alt-screen',
        ],
      })),
    ),
  );
}
for (const name of ['agent-a', 'agent-b']) {
  if (reuse === undefined)
    await command([
      'new',
      name,
      root,
      '--agent',
      'codex',
      '--runtime',
      'app-server',
      '--',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--no-alt-screen',
    ]);
  else await command(['restart', name]);
  const session = loadSessions(machine).find((row) => row.name === name);
  if (session === undefined) throw new Error('Native create did not publish its ready identity');
  const deadline = Date.now() + 45_000;
  while (readOwnedCodexStatus(machine, session).status !== 'live') {
    if (Date.now() >= deadline)
      throw new Error('Native session has no live resident status after admission');
    await Bun.sleep(200);
  }
  const rpc = await connectCodexSocket(ownedCodexSocket(machine, name));
  try {
    const thread = await readCodexAppThread(rpc, session.uuid);
    const resident = readOwnedCodexStatus(machine, session);
    if (resident.snapshot?.threadId !== thread.id)
      throw new Error('Native and resident identities disagree');
    console.log(
      JSON.stringify({ phase: 'ready', name, uuid: session.uuid, native: thread.status, resident }),
    );
  } finally {
    rpc.close();
  }
}
await newSession(
  machine,
  'probe-daemon',
  root,
  [process.execPath, '--no-env-file', cli, 'daemon'],
  env,
);
console.log(
  JSON.stringify({
    phase: 'launched',
    config,
    sessions: loadSessions(machine).map(({ name, uuid }) => ({ name, uuid })),
  }),
);
