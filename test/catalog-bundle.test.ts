import { expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeProcessInstance, probeProcessOwner } from 'stitchkit/process';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { makeMachine } from './helpers.ts';

async function bundle(root: string) {
  const output = join(root, 'ccmux.js');
  const builder = join(import.meta.dir, '../scripts/bundle.ts');
  const build = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { buildBundle } from ${JSON.stringify(builder)}; process.exit(await buildBundle(process.argv[1]) ? 0 : 1);`,
      output,
    ],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await build.exited).toBe(0);
  return output;
}

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Bundled catalog check timed out: ${label}`);
}

function killFixture(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

test('the release bundle serves the host model catalog through its guarded metadata process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-catalog-bundle-'));
  const output = await bundle(root);
  const bin = join(root, 'codex');
  copyFileSync(join(import.meta.dir, 'fixtures/catalog-server.ts'), bin);
  chmodSync(bin, 0o700);
  const machine = makeMachine({
    stateDir: join(root, 'state'),
    rcPrefix: 'host-a',
    projectsDir: root,
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
    tmuxSocket: `ccmux-catalog-${crypto.randomUUID()}`,
    codexBin: bin,
    codexHome: root,
    chatEnabled: false,
    autoUpdate: false,
    ensureInterval: 3600,
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(machine));
  const env = {
    ...process.env,
    CCMUX_CONFIG: config,
    CCMUX_STATE_DIR: machine.stateDir,
    CCMUX_DATA_DIR: join(root, 'data'),
    CCMUX_CACHE_DIR: join(root, 'cache'),
  };
  const daemon = Bun.spawn([process.execPath, output, 'daemon'], {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const log = new Response(daemon.stderr).text();
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(controlSocket(machine)) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(controlSocket(machine))).toBe(true);
    const cli = Bun.spawn([process.execPath, output, 'control', 'models', '--runtime', 'codex'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
    ]);
    const diagnosticPath = join(machine.stateDir, 'control', 'catalog-diagnostic.json');
    const diagnostic = existsSync(diagnosticPath)
      ? readFileSync(diagnosticPath, 'utf8')
      : 'no private diagnostic';
    expect({ code, stderr, diagnostic }).toMatchObject({ code: 0 });
    expect(stdout).toContain('model-a');
    expect(existsSync(join(root, 'fixture.pid'))).toBe(true);
  } finally {
    daemon.kill('SIGTERM');
    await daemon.exited;
    await log;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

for (const phase of ['before-listen', 'after-initialize', 'hanging-rpc']) {
  test(`the release bundle reaps metadata after owner SIGKILL during ${phase}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-catalog-bundle-kill-'));
    const output = await bundle(root);
    const bin = join(root, 'codex');
    const target = readFileSync(join(import.meta.dir, 'fixtures/catalog-owner-server.ts'), 'utf8');
    writeFileSync(
      bin,
      phase === 'before-listen'
        ? target.replace("process.argv.includes('before-listen')", 'true')
        : target,
    );
    chmodSync(bin, 0o700);
    const machine = makeMachine({
      stateDir: join(root, 'state'),
      rcPrefix: 'host-a',
      projectsDir: root,
      tmuxBin: Bun.which('tmux') ?? '/usr/bin/false',
      tmuxSocket: `ccmux-catalog-${crypto.randomUUID()}`,
      codexBin: bin,
      codexHome: root,
      chatEnabled: false,
      autoUpdate: false,
      ensureInterval: 3600,
    });
    const config = join(root, 'machine.json');
    writeFileSync(config, JSON.stringify(machine));
    const env = {
      ...process.env,
      CCMUX_CONFIG: config,
      CCMUX_STATE_DIR: machine.stateDir,
      CCMUX_DATA_DIR: join(root, 'data'),
      CCMUX_CACHE_DIR: join(root, 'cache'),
    };
    const owner = Bun.spawn([process.execPath, output, 'daemon'], {
      env,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const log = new Response(owner.stderr).text();
    const neighbor = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      env: process.env,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const tracked: {
      pid: number;
      observation: Awaited<ReturnType<typeof observeProcessInstance>>;
    }[] = [];
    try {
      await until(() => existsSync(join(root, 'member.pid')), 'provider and descendant started');
      for (const name of ['guard.pid', 'target.pid', 'member.pid']) {
        const pid = Number(readFileSync(join(root, name), 'utf8'));
        tracked.push({ pid, observation: await observeProcessInstance(pid) });
      }
      for (const { observation } of tracked) expect(observation.state).toBe('observed');
      const neighborIdentity = await observeProcessInstance(neighbor.pid);
      expect(neighborIdentity.state).toBe('observed');
      if (phase !== 'before-listen')
        await until(
          () => existsSync(join(root, phase === 'hanging-rpc' ? 'rpc' : 'initialized')),
          phase,
        );
      owner.kill('SIGKILL');
      await owner.exited;
      await until(async () => {
        const results = await Promise.all(
          tracked.map(async ({ pid, observation }) => {
            if (observation.state !== 'observed') throw new Error('Missing fixture identity');
            return probeProcessOwner(pid, observation.instance);
          }),
        );
        return results.every((result) => result.liveness === 'gone');
      }, 'guard, provider and descendant death');
      if (neighborIdentity.state !== 'observed') throw new Error('Missing neighbor identity');
      expect((await probeProcessOwner(neighbor.pid, neighborIdentity.instance)).identity).toBe(
        'matched',
      );
    } finally {
      owner.kill('SIGKILL');
      neighbor.kill('SIGKILL');
      await Promise.all([owner.exited, neighbor.exited, log]);
      for (const { pid, observation } of tracked) {
        if (
          observation.state === 'observed' &&
          (await probeProcessOwner(pid, observation.instance)).identity === 'matched'
        )
          killFixture(pid);
      }
      const directory = join(root, 'runtime.directory');
      if (existsSync(directory))
        rmSync(readFileSync(directory, 'utf8'), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}
