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

/**
 * The pid the fixture wrote, waited for rather than assumed.
 *
 * Same shape as `gone` below it and for the same reason: the child is spawned before the read is
 * cancelled, but WRITING its pid is its own first act, and a cancel that arrives inside 400ms can
 * beat it on a loaded machine. Reading the file at that instant asserts which of the two won the
 * race, not that the process was reaped — and it failed only inside the full suite, never alone.
 */
async function startedPid(root: string, withinMs = 2_000): Promise<number | null> {
  const path = join(root, 'fixture.pid');
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (text.length > 0) return Number(text);
    }
    await Bun.sleep(10);
  }
  // Announcing the pid is the child's first act, so nothing within this window means the cancel
  // beat the spawn and there is no child to reap. The companion assertion — that no managed row was
  // created — still runs, so a cancel that leaves a writer behind is caught either way.
  return null;
}

async function reaped(root: string) {
  const pid = await startedPid(root);
  if (pid !== null) await gone(pid);
  // A cancel can land before the child has served — or even received — a single request, so an
  // absent log is "it was asked nothing", not a broken fixture. Reading it as a hard precondition
  // asserted which of two racing acts won, which is not what this test is about.
  const path = join(root, 'requests.jsonl');
  const requests = (existsSync(path) ? readFileSync(path, 'utf8') : '')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
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
      observedAt: null,
      freshness: null,
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
