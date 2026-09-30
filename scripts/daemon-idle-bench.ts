import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { histFile } from '../src/agent/claude/resume.ts';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { SessionSchema } from '../src/session/schema.ts';
import { createDaemonBenchProvider } from './daemonBenchProvider.ts';

// Full application in a separate process, with synthetic history and its own tmux server/roots.
// No provider, real session, outbound peer or installed code participates in this workload.
const duration = Number(Bun.argv[2] ?? 600);
const output = Bun.argv[3];
const profile = Bun.argv.slice(4).includes('--profile');
const only = Bun.argv
  .slice(4)
  .find((arg) => arg.startsWith('--only='))
  ?.slice(7);
const baselineBundle = Bun.argv
  .slice(4)
  .find((arg) => arg.startsWith('--baseline='))
  ?.slice(11);
if (!Number.isFinite(duration) || duration < 1 || !output)
  throw new Error('usage: bun scripts/daemon-idle-bench.ts <seconds> <output.json>');
const root = mkdtempSync(join(tmpdir(), 'ccmux-daemon-bench-'));
const socket = `ccmux-bench-${crypto.randomUUID()}`;
const tmux = Bun.which('tmux');
if (!tmux) throw new Error('tmux required');
const machine = MachineConfigSchema.parse({
  claudeBin: '/usr/bin/false',
  codexBin: '/usr/bin/false',
  opencodeBin: '/usr/bin/false',
  codexHome: join(root, 'codex'),
  codexSessionsDir: join(root, 'codex', 'sessions'),
  tmuxBin: tmux,
  tmuxSocket: socket,
  rcPrefix: 'bench',
  stateDir: root,
  projectsDir: join(root, 'transcripts'),
  bootLabel: 'isolated-bench',
  autoUpdate: false,
  chatEnabled: false,
});
const config = join(root, 'machine.json');
writeFileSync(config, JSON.stringify(machine));
const sessions = Array.from({ length: 29 }, (_, i) =>
  SessionSchema.parse({
    name: `agent-${i}`,
    dir: root,
    uuid: crypto.randomUUID(),
    agent: 'claude',
    archived: i >= 18,
  }),
);
writeFileSync(
  join(root, 'sessions.jsonl'),
  `${sessions.map((s) => JSON.stringify(s)).join('\n')}\n`,
);
for (const session of sessions) {
  const history = histFile(root, session.uuid, machine.projectsDir);
  mkdirSync(dirname(history), { recursive: true });
  const records = Array.from({ length: 1000 }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        id: `message-${i}`,
        role: 'assistant',
        model: 'bench-model',
        content: [{ type: 'text', text: 'synthetic history '.repeat(20) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  );
  writeFileSync(history, `${records.join('\n')}\n`);
}
const externalIds = Array.from({ length: 9 }, () => crypto.randomUUID());
mkdirSync(machine.codexSessionsDir ?? '', { recursive: true });
for (const id of externalIds) {
  const records = [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }),
    ...Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: (i + 1) * 10,
              output_tokens: (i + 1) * 5,
              total_tokens: (i + 1) * 15,
            },
          },
        },
      }),
    ),
  ];
  writeFileSync(
    join(machine.codexSessionsDir ?? '', `rollout-test-${id}.jsonl`),
    `${records.join('\n')}\n`,
    { mode: 0o600 },
  );
}
const provider = createDaemonBenchProvider(machine.codexHome ?? '', externalIds);
const env = {
  ...process.env,
  CCMUX_CONFIG: config,
  CCMUX_STATE_DIR: root,
  CCMUX_CACHE_DIR: join(root, 'cache'),
  CCMUX_DATA_DIR: join(root, 'data'),
  CCMUX_RC_PREFIX: machine.rcPrefix,
};
const invoke = (...args: string[]) => {
  const result = Bun.spawnSync([tmux, '-L', socket, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};
let worker: ReturnType<typeof Bun.spawn> | undefined;
try {
  for (const session of sessions.filter((s) => !s.archived))
    invoke(
      'new-session',
      '-d',
      '-s',
      session.name,
      'sh',
      '-c',
      "printf '───\n❯ \n? for shortcuts\n'; exec sleep 3600",
    );
  const bundle = join(root, 'worker.js');
  if (baselineBundle) await Bun.write(bundle, Bun.file(baselineBundle));
  else {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'daemonIdleWorker.ts')],
      outdir: root,
      naming: 'worker.js',
      target: 'bun',
    });
    if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  }
  const workerArgv = [
    process.execPath,
    ...(profile
      ? [
          '--cpu-prof-md',
          `--cpu-prof-dir=${dirname(output)}`,
          `--cpu-prof-name=${output.split('/').at(-1)}.profile.txt`,
        ]
      : []),
    bundle,
    String(duration),
    ...(only ? [only] : []),
  ];
  const running = Bun.spawn(workerArgv, { env, stdout: 'pipe', stderr: 'pipe' });
  worker = running;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(running.stdout).text(),
    new Response(running.stderr).text(),
    running.exited,
  ]);
  await Bun.write(`${output}.stderr.log`, stderr);
  if (exitCode !== 0) throw new Error(`worker exit ${exitCode}: ${stderr}`);
  const result = JSON.parse(stdout.trim());
  await Bun.write(
    output,
    JSON.stringify(
      {
        platform: process.platform,
        duration,
        sessions: 29,
        externalThreads: externalIds.length,
        running: 18,
        archived: 11,
        historyRecordsPerSession: 1000,
        resourceUsage: worker.resourceUsage(),
        ...result,
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill();
    await worker.exited;
  }
  Bun.spawnSync([tmux, '-L', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
  provider.stop(true);
  rmSync(root, { recursive: true, force: true });
}
