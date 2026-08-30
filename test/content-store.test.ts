import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { OwnedCodexProjection } from '../src/agent/codex/ownedProjection.ts';
import { OwnedCodexStatusWriter } from '../src/agent/codex/ownedStatus.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { appendSession } from '../src/config/sessions.ts';
import { ContentProducer } from '../src/content/producer.ts';
import { readContent, subscribeContent } from '../src/content/read.ts';
import { contentPath } from '../src/content/store.ts';
import { subscribeControlNative } from '../src/control/nativeFeed.ts';
import { makeMachine, makeSession } from './helpers.ts';

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('coalesced content publication, slow reader recovery and cancellation stay bounded', async () => {
  const root = mkdtempSync('/tmp/ccmux-content-test-');
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
  const s = makeSession({
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
  });
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: 'idle' }, 0);
  const status = new OwnedCodexStatusWriter(m, s.name);
  await status.write(projection.snapshot());
  const producer = new ContentProducer(m, s, projection.snapshot().generation);
  const abort = new AbortController();
  try {
    producer.buffer.text('assistant', 'turn-a', 'item-a', '', 'replace');
    producer.publish();
    await producer.writer.flush();
    expect(readContent(m, s).status).toBe('live');
    const iterator = subscribeContent(m, s, null, abort.signal)[Symbol.asyncIterator]();
    const first = await deadline(iterator.next(), 'initial frame did not arrive');
    expect(first.value?.reset).toBe('initial');
    const before = readFileSync(contentPath(m, s), 'utf8');
    for (let i = 0; i < 700; i++) {
      producer.buffer.text('assistant', 'turn-a', 'item-a', 'hello', 'append');
      producer.publish();
    }
    expect(readFileSync(contentPath(m, s), 'utf8')).toBe(before);
    await producer.writer.flush();
    expect(readContent(m, s).sequence).toBeGreaterThan(first.value?.sequence ?? 0);
    const next = await deadline(iterator.next(), 'changed content notification did not arrive');
    expect(next.value?.reset).toBe('gap');
    expect(next.value?.baseline[0]?.text).toBe('hello'.repeat(700));
    abort.abort();
    await iterator.return?.();
    expect(() => readContent(m, { ...s, registrationGeneration: crypto.randomUUID() })).toThrow(
      'Native content is unavailable',
    );
  } finally {
    abort.abort();
    await producer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reader does not publish content from a retired observer generation', async () => {
  const root = mkdtempSync('/tmp/ccmux-content-generation-');
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
  const s = makeSession({
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
  });
  const current = new OwnedCodexProjection(m, s, process.pid);
  current.reconcile({ type: 'idle' }, 0);
  await new OwnedCodexStatusWriter(m, s.name).write(current.snapshot());
  const old = new ContentProducer(m, s, crypto.randomUUID());
  try {
    old.buffer.text('assistant', 'old-turn', 'old-item', 'old content', 'replace', true);
    old.publish();
    await old.writer.flush();
    expect(readContent(m, s)).toMatchObject({ status: 'unavailable', records: [], baseline: [] });
  } finally {
    await old.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed subscriber construction closes partially opened filesystem watchers', async () => {
  const source = `
    import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
    import { dirname } from "node:path";
    import { makeMachine, makeSession } from "./test/helpers.ts";
    import { contentPath } from "./src/content/store.ts";
    import { subscribeContent } from "./src/content/read.ts";
    const root = mkdtempSync("/tmp/ccmux-content-startup-");
    const m = makeMachine({ stateDir: root });
    const s = makeSession({ agent: "codex", runtime: "app-server", registrationGeneration: crypto.randomUUID() });
    mkdirSync(dirname(contentPath(m, s)), { recursive: true, mode: 0o700 });
    for (let i = 0; i < 40; i++) {
      let refused = false;
      try { await subscribeContent(m, s, null, new AbortController().signal)[Symbol.asyncIterator]().next(); }
      catch { refused = true; }
      if (!refused) throw new Error("Missing notice did not refuse");
    }
    rmSync(root, { recursive: true, force: true });
  `;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    expect(await deadline(child.exited, 'Failed content subscriptions retained watchers')).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
});

test('idle lease and native settings updates stream without inventing content sequence', async () => {
  const root = mkdtempSync('/tmp/ccmux-content-metadata-');
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
  const s = makeSession({
    agent: 'codex',
    runtime: 'app-server',
    registrationGeneration: crypto.randomUUID(),
  });
  await appendSession(m, s);
  const projection = new OwnedCodexProjection(m, s, process.pid);
  projection.reconcile({ type: 'idle' }, 0);
  const writer = new OwnedCodexStatusWriter(m, s.name);
  const initial = projection.snapshot();
  initial.expiresAt = new Date(Date.now() + 500).toISOString();
  await writer.write(initial);
  const producer = new ContentProducer(m, s, initial.generation);
  producer.publish();
  await producer.writer.flush();
  const abort = new AbortController();
  const iterator = subscribeControlNative(m, managedPeer(m.rcPrefix, s), null, abort.signal)[
    Symbol.asyncIterator
  ]();
  try {
    const first = await deadline(iterator.next(), 'Initial native metadata missing');
    projection.reconcile({ type: 'idle' }, 0);
    const fresh = projection.snapshot();
    fresh.nativeSelection = {
      model: { provider: 'openai', model: 'model-new' },
      options: null,
      source: 'settings',
      turnId: null,
    };
    await writer.write(fresh);
    const next = await deadline(iterator.next(), 'Metadata-only frame suppressed');
    expect(next.value?.sequence).toBe(first.value?.sequence);
    expect(next.value?.nativeSelection?.model.model).toBe('model-new');
    expect(Date.parse(next.value?.expiresAt ?? '')).toBeGreaterThan(
      Date.parse(first.value?.expiresAt ?? ''),
    );
    expect(next.value?.records).toEqual([]);
  } finally {
    abort.abort();
    await iterator.return?.();
    await producer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
