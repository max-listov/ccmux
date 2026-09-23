import { expect, test } from 'bun:test';
import { AppError } from 'stitchkit';
import { HostCatalogCache } from '../src/control/modelCatalogCache.ts';
import { type ControlModelCatalog, ControlModelsReadSchema } from '../src/control/schema/model.ts';

const input = ControlModelsReadSchema.parse({});

function catalog(id: string): ControlModelCatalog {
  return {
    source: {
      kind: 'host',
      machine: 'host-a',
      provider: 'openai',
      providerLabel: null,
      runtime: 'codex',
      observedAt: null,
      freshness: null,
    },
    data: [
      {
        id,
        displayName: id,
        description: '',
        hidden: false,
        isDefault: true,
        inputModalities: ['text'],
        serviceTiers: [],
      },
    ],
    nextCursor: null,
  };
}

/** A read the test finishes by hand, standing in for a metadata App Server's cold start. */
function controlledRead() {
  const calls: Array<{
    resolve: (value: ControlModelCatalog) => void;
    reject: (e: unknown) => void;
  }> = [];
  const read = () =>
    new Promise<ControlModelCatalog>((resolve, reject) => calls.push({ resolve, reject }));
  return { read, calls };
}

function cache(read: () => Promise<ControlModelCatalog>, clock: { now: number }) {
  return new HostCatalogCache(read, {
    liveMs: 1_000,
    readMs: 60_000,
    waitMs: 30,
    now: () => clock.now,
  });
}

test('a caller with no copy is told the read is still running, and the read carries on', async () => {
  const clock = { now: 10_000 };
  const { read, calls } = controlledRead();
  const hosts = cache(read, clock);
  const refusal = await hosts.get(input).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).code).toBe('UNAVAILABLE');
  expect(calls.length).toBe(1);
  calls[0]?.resolve(catalog('model-a'));
  await Bun.sleep(0);
  const served = await hosts.get(input);
  expect(calls.length).toBe(1);
  expect(served.data.map((row) => row.id)).toEqual(['model-a']);
  expect(served.source.observedAt).toBe(new Date(10_000).toISOString());
  expect(served.source.freshness).toBe('live');
});

test('a read that finishes within the wait is answered directly', async () => {
  const clock = { now: 0 };
  const hosts = cache(async () => catalog('model-a'), clock);
  expect((await hosts.get(input)).data[0]?.id).toBe('model-a');
});

test('an old copy is served as stale while exactly one fresh read runs', async () => {
  const clock = { now: 0 };
  const { read, calls } = controlledRead();
  const hosts = cache(read, clock);
  void hosts.refresh(input);
  calls[0]?.resolve(catalog('old'));
  await Bun.sleep(0);
  clock.now = 5_000;
  const first = await hosts.get(input);
  const second = await hosts.get(input);
  expect(first.source.freshness).toBe('stale');
  expect(second.data[0]?.id).toBe('old');
  expect(calls.length).toBe(2);
  calls[1]?.resolve(catalog('new'));
  await Bun.sleep(0);
  const renewed = await hosts.get(input);
  expect(renewed.data[0]?.id).toBe('new');
  expect(renewed.source.freshness).toBe('live');
});

test('a failed read keeps the last good copy and the next caller retries', async () => {
  const clock = { now: 0 };
  const { read, calls } = controlledRead();
  const hosts = cache(read, clock);
  void hosts.refresh(input);
  calls[0]?.resolve(catalog('good'));
  await Bun.sleep(0);
  clock.now = 5_000;
  await hosts.get(input);
  calls[1]?.reject(new Error('provider went away'));
  await Bun.sleep(0);
  expect((await hosts.get(input)).data[0]?.id).toBe('good');
  expect(calls.length).toBe(3);
});

test('a read that fails before any copy exists fails the caller waiting on it', async () => {
  const clock = { now: 0 };
  const hosts = cache(async () => {
    throw new AppError('UNAVAILABLE', 'Model catalog is unavailable', 503);
  }, clock);
  const error = await hosts.get(input).catch((e: unknown) => e);
  expect((error as AppError).message).toBe('Model catalog is unavailable');
});

test('closing the cache cancels a read in flight', async () => {
  let seen: AbortSignal | undefined;
  const hosts = new HostCatalogCache(
    (_input, signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    { liveMs: 1_000, readMs: 60_000, waitMs: 5, now: () => 0 },
  );
  await hosts.get(input).catch(() => {});
  expect(seen?.aborted).toBe(false);
  hosts.close();
  expect(seen?.aborted).toBe(true);
});
