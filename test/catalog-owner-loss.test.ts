import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeProcessInstance, probeProcessOwner } from 'stitchkit/process';

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Catalog owner-loss check timed out: ${label}`);
}

function killFixture(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

for (const phase of ['before-listen', 'after-initialize', 'hanging-rpc']) {
  test(`catalog owner SIGKILL reaps its complete group during ${phase}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccmux-owner-loss-'));
    const executable = join(root, 'codex');
    copyFileSync(join(import.meta.dir, 'fixtures/catalog-owner-server.ts'), executable);
    if (phase === 'before-listen') {
      // The host's normal flag path reaches the provider fixture; no test-only runtime option.
      const original = readFileSync(executable, 'utf8');
      await Bun.write(
        executable,
        original.replace("process.argv.includes('before-listen')", 'true'),
      );
    }
    chmodSync(executable, 0o700);
    const neighbor = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      env: process.env,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const owner = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'fixtures/catalog-owner.ts'), root, executable],
      { env: process.env, stdout: 'ignore', stderr: 'pipe' },
    );
    const tracked: {
      pid: number;
      observation: Awaited<ReturnType<typeof observeProcessInstance>>;
    }[] = [];
    try {
      await until(() => existsSync(join(root, 'member.pid')), 'provider descendant started');
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
      }, 'provider and descendant death');
      if (neighborIdentity.state !== 'observed') throw new Error('Missing neighbor identity');
      expect((await probeProcessOwner(neighbor.pid, neighborIdentity.instance)).identity).toBe(
        'matched',
      );
    } finally {
      owner.kill('SIGKILL');
      neighbor.kill('SIGKILL');
      await Promise.all([owner.exited, neighbor.exited]);
      for (const { pid, observation } of tracked) {
        if (
          observation.state !== 'observed' ||
          (await probeProcessOwner(pid, observation.instance)).identity !== 'matched'
        )
          continue;
        killFixture(pid);
      }
      const directory = join(root, 'runtime.directory');
      if (existsSync(directory))
        rmSync(readFileSync(directory, 'utf8'), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
}
