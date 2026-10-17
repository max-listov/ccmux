import { expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { lifecycleBlockPath } from '../src/config/paths.ts';
import { appendSession } from '../src/session/registry.ts';
import { SessionSchema } from '../src/session/schema.ts';

// The real path: a deployed bundle supervising a session, the bundle replaced on disk while the agent
// runs, the agent exiting. The supervisor must leave without judging the session by the code it was
// loaded with — and the same supervisor, untouched, must relaunch the agent (the control that proves
// the exit is the update's doing and not the stand-in agent's).

const UUID = '44444444-4444-4444-8444-444444444444';

async function buildBundle(out: string): Promise<void> {
  const builder = join(import.meta.dir, '..', 'scripts', 'bundle.ts');
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {buildBundle} from ${JSON.stringify(builder)}; process.exit(await buildBundle(process.argv[1]) ? 0 : 1);`,
      out,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  expect(await proc.exited).toBe(0);
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-supervisor-update-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const dir = join(root, 'project');
  mkdirSync(dir);
  const launches = join(root, 'launches');
  // The stand-in agent: records that it was started, lives a moment, exits.
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/bin/sh\necho started >> ${JSON.stringify(launches)}\nsleep 1\n`);
  chmodSync(claude, 0o755);
  const tmux = join(root, 'tmux');
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n');
  chmodSync(tmux, 0o755);
  const machine = MachineConfigSchema.parse({
    claudeBin: claude,
    tmuxBin: tmux,
    projectsDir: join(root, 'projects'),
    rcPrefix: 'host-a',
    stateDir,
    bootLabel: 'ccmux.service',
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));
  await appendSession(
    machine,
    SessionSchema.parse({ name: 'agent-a', dir, agent: 'claude', uuid: UUID }),
  );
  const bundle = join(root, 'ccmux.js');
  await buildBundle(bundle);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = config;
  env.CCMUX_STATE_DIR = stateDir;
  env.HOME = root;
  delete env.CLAUDE_CONFIG_DIR;
  const supervisor = Bun.spawn([process.execPath, '--no-env-file', bundle, '_run', 'agent-a'], {
    env,
    cwd: dir,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const count = () =>
    existsSync(launches) ? readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0;
  return { machine, bundle, supervisor, count };
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const stop = Date.now() + ms; Date.now() < stop; ) {
    if (done()) return true;
    await Bun.sleep(50);
  }
  return done();
}

test('a supervisor whose bundle was replaced leaves after the agent exits, without a second launch or a block', async () => {
  const w = await world();
  expect(await until(() => w.count() === 1, 15_000)).toBe(true);
  // An update: the file at the same path is replaced by a different one.
  appendFileSync(w.bundle, '\n// updated\n');
  const code = await Promise.race([w.supervisor.exited, Bun.sleep(20_000).then(() => 'alive')]);
  if (code === 'alive') w.supervisor.kill('SIGKILL');
  expect(code).toBe(0);
  expect(w.count()).toBe(1);
  expect(existsSync(lifecycleBlockPath(w.machine, 'agent-a'))).toBe(false);
}, 60_000);

test('control: the same supervisor, bundle untouched, launches the agent again', async () => {
  const w = await world();
  const relaunched = await until(() => w.count() >= 2, 20_000);
  w.supervisor.kill('SIGKILL');
  await w.supervisor.exited;
  expect(relaunched).toBe(true);
}, 60_000);

test('a bundle replaced while the supervisor waits out its back-off is noticed before the next launch', async () => {
  const w = await world();
  expect(await until(() => w.count() === 1, 15_000)).toBe(true);
  // The agent lives 1 s and exits fast, so a back-off of seconds follows; replace the bundle inside it.
  await Bun.sleep(1_800);
  appendFileSync(w.bundle, '\n// updated during back-off\n');
  const code = await Promise.race([w.supervisor.exited, Bun.sleep(20_000).then(() => 'alive')]);
  if (code === 'alive') w.supervisor.kill('SIGKILL');
  expect(code).toBe(0);
  expect(w.count()).toBe(1);
}, 60_000);
