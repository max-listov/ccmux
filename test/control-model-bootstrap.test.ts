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

function reaped(root: string) {
  const pid = Number(readFileSync(join(root, 'fixture.pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
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
      ControlModelsReadSchema.parse({}),
      AbortSignal.timeout(3_000),
    );
    expect(page.source).toEqual({ kind: 'host', machine: f.machine.rcPrefix, provider: 'openai' });
    expect(page.target).toBeUndefined();
    expect(page.data[0]).toMatchObject({ id: 'preset-a', model: 'model-a' });
    expect(loadSessions(f.machine)).toEqual([]);
    reaped(f.root);
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
    reaped(f.root);
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
