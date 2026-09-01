import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadSessions } from '../src/config/sessions.ts';
import { readControlModels } from '../src/control/models.ts';
import { ControlModelsReadSchema } from '../src/control/schema.ts';
import { makeMachine } from './helpers.ts';

function fixture() {
  const root = mkdtempSync('/tmp/ccmux-catalog-test-');
  const bin = join(root, 'codex');
  copyFileSync(join(import.meta.dir, 'fixtures/catalog-server.ts'), bin);
  chmodSync(bin, 0o700);
  const machine = makeMachine({ codexBin: bin, codexHome: root, stateDir: join(root, 'state') });
  return { root, machine };
}

/**
 * The metadata child is gone, asserted against what the code guarantees.
 *
 * Reaping is ordered after the read rejects: the promise settles, the child is signalled, and the
 * kernel removes it. Demanding that it already be gone at the instant the caller regains control
 * asserts the scheduler's speed rather than the reap — which is why this case failed only inside the
 * full suite and only on a busy machine, three times, and passed alone every time.
 *
 * Waiting for the observable state keeps the assertion's teeth: a child that is never reaped still
 * fails this, and says so with its pid rather than with a timeout nobody can read.
 */
async function gone(pid: number, withinMs = 5_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `metadata process ${pid} was still alive after ${withinMs}ms — it was not reaped`,
  );
}

async function reaped(root: string) {
  const pid = Number(readFileSync(join(root, 'fixture.pid'), 'utf8'));
  await gone(pid);
  const requests = readFileSync(join(root, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(requests.some((request) => request.method.startsWith('thread/'))).toBe(false);
}

test('host catalog needs no managed row and metadata child is reaped', async () => {
  const f = fixture();
  try {
    const page = await readControlModels(
      f.machine,
      ControlModelsReadSchema.parse({ runtime: 'codex' }),
      AbortSignal.timeout(3_000),
    );
    expect(page.source).toEqual({
      kind: 'host',
      machine: f.machine.rcPrefix,
      provider: 'openai',
      providerLabel: null,
      runtime: 'codex',
    });
    expect(page.target).toBeUndefined();
    expect(page.data[0]).toMatchObject({ id: 'preset-a', model: 'model-a' });
    expect(loadSessions(f.machine)).toEqual([]);
    await reaped(f.root);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('cancelled host read reaps its metadata process without creating a writer', async () => {
  const f = fixture();
  try {
    await expect(
      readControlModels(
        f.machine,
        ControlModelsReadSchema.parse({ cursor: 'hang' }),
        AbortSignal.timeout(400),
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(loadSessions(f.machine)).toEqual([]);
    await reaped(f.root);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unknown profile and invalid selectors fail before metadata spawn', async () => {
  const f = fixture();
  try {
    await expect(
      readControlModels(
        f.machine,
        ControlModelsReadSchema.parse({ launchRecipe: { id: 'missing', revision: '1' } }),
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toMatchObject({ code: 'LAUNCH_RECIPE_UNAVAILABLE' });
    expect(existsSync(join(f.root, 'fixture.pid'))).toBe(false);
    for (const extra of [
      { executable: '/bin/sh' },
      { endpoint: 'https://example.invalid' },
      { path: '/work' },
      { credential: 'fixture' },
    ])
      expect(ControlModelsReadSchema.safeParse(extra).success).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
