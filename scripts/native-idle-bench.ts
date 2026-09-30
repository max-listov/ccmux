import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { SessionSchema } from '../src/session/schema.ts';
import { nativeIdleFixture } from './nativeIdleFixture.ts';

const duration = Number(Bun.argv[2] ?? 600),
  output = Bun.argv[3],
  worker = Bun.argv[4];
if (!output || !worker || !Number.isFinite(duration) || duration < 1)
  throw new Error('usage: native-idle-bench seconds output.json worker.js');
const root = mkdtempSync('/tmp/ccmux-native-idle-');
const uuid = crypto.randomUUID();
const m = MachineConfigSchema.parse({
  stateDir: root,
  rcPrefix: 'bench',
  bootLabel: 'isolated-bench',
  claudeBin: '/usr/bin/false',
  tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
  tmuxSocket: `ccmux-native-bench-${uuid}`,
  codexHome: join(root, 'codex'),
  codexSessionsDir: join(root, 'codex', 'sessions'),
  projectsDir: join(root, 'transcripts'),
  claudeNativeRuntime: true,
  autoUpdate: false,
  chatEnabled: false,
});
const base = SessionSchema.parse({
  name: 'agent-a',
  uuid,
  dir: root,
  agent: 'codex',
  runtime: 'app-server',
  registrationGeneration: crypto.randomUUID(),
});
const fixture = nativeIdleFixture(root, m, base);
m.codexBin = fixture.path;
m.claudeNativeSdk = fixture.sdk;
const config = join(root, 'machine.json');
writeFileSync(config, JSON.stringify(m));
const claude = SessionSchema.parse({
  ...base,
  name: 'agent-b',
  uuid: base.registrationGeneration,
  agent: 'claude',
  runtime: 'native',
  nativeSession: { runtime: 'claude', id: base.registrationGeneration, version: 'fixture' },
});
writeFileSync(join(root, 'sessions.jsonl'), `${JSON.stringify(base)}\n${JSON.stringify(claude)}\n`);
const children = new Set<ReturnType<typeof Bun.spawn>>();
async function stopChildren() {
  const running = [...children].filter((child) => child.exitCode === null);
  for (const child of running) child.kill('SIGTERM');
  const force = setTimeout(() => {
    for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  }, 2_000);
  try {
    await Promise.allSettled(running.map((child) => child.exited));
  } finally {
    clearTimeout(force);
  }
}
const deadline = setTimeout(
  () => {
    void stopChildren();
  },
  (duration + 30) * 1000,
);
try {
  const results = await Promise.all(
    ['codex', 'claude'].map(async (provider) => {
      const s = provider === 'codex' ? base : claude;
      const child = Bun.spawn(
        [
          process.execPath,
          ...(Bun.argv.includes('--profile')
            ? [
                '--cpu-prof-md',
                `--cpu-prof-dir=${dirname(output)}`,
                `--cpu-prof-name=${basename(output)}.${provider}.md`,
              ]
            : []),
          worker,
          String(duration),
          JSON.stringify(s),
        ],
        {
          env: {
            ...process.env,
            CCMUX_CONFIG: config,
            CCMUX_STATE_DIR: root,
            CCMUX_CACHE_DIR: join(root, 'cache'),
            CCMUX_DATA_DIR: join(root, 'data'),
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      children.add(child);
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      children.delete(child);
      if (code !== 0) throw new Error(`${provider} exit ${code}: ${stderr}`);
      return { provider, ...JSON.parse(stdout.trim()) };
    }),
  );
  await Bun.write(
    output,
    JSON.stringify(
      {
        platform: process.platform,
        duration,
        provider: 'stand-in; real owner and mailboxes',
        results,
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  clearTimeout(deadline);
  await stopChildren();
  rmSync(root, { recursive: true, force: true });
}
