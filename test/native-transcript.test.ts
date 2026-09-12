import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateRuntimeDirectory } from '../src/agent/codex/ownedPaths.ts';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { managedPeer } from '../src/chat/identity.ts';
import { transcriptJson } from '../src/commands/transcript.ts';
import { withDirectoryLock } from '../src/config/registryLock.ts';
import { appendSession } from '../src/config/sessions.ts';
import { boundedHistoryPage, historyCursor } from '../src/context/history.ts';
import { applyContextCommands, type NativeContextApi } from '../src/context/pump.ts';
import type { NativeHistoryEntry } from '../src/context/schema.ts';
import { readNativeHistory } from '../src/context/service.ts';
import { contextPath } from '../src/context/store.ts';
import { nativeTranscriptWindow, readTranscriptWindow } from '../src/context/transcriptWindow.ts';
import { ControlTranscriptReadSchema } from '../src/control/schema.ts';
import { readControlTranscript } from '../src/control/transcript.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

const entry = (
  kind: NativeHistoryEntry['kind'],
  itemId: string,
  text: string | null,
): NativeHistoryEntry => ({
  turnId: itemId,
  itemId,
  kind,
  text,
  omittedBytes: 0,
  images: [],
  omittedImages: 0,
  status: 'completed',
  tool: null,
});

test('a native window maps entries to the transcript contract and keeps absolute seq', () => {
  const tool: NativeHistoryEntry = {
    ...entry('tool', 'i4', null),
    tool: {
      callId: 'call-4',
      name: 'bash',
      lifecycle: 'completed',
      outcome: 'succeeded',
      exitCode: 0,
    },
  };
  const entries = [
    entry('user', 'i1', 'question'),
    entry('assistant', 'i2', 'answer'),
    entry('reasoning-summary', 'i3', 'thinking'),
    tool,
    entry('user', 'i5', 'follow-up'),
  ];
  const read = nativeTranscriptWindow('opencode', entries, { tail: 3 });
  expect(read.source).toBe('native');
  expect(read.available).toBe(true);
  expect(read.mtimeMs).toBeNull();
  expect(read.totalLines).toBe(5);
  expect(read.firstLine).toBe(3);
  expect(read.reachedStart).toBe(false);
  // seq is the absolute index into the conversation, not the index into this window.
  expect(read.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
  expect(read.messages.map((m) => m.kind)).toEqual(['thinking', 'tool_call', 'message']);
  expect(read.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
  expect(read.messages[1]?.done).toBe(true);
  expect(read.messages[1]?.toolName).toBe('bash');
  expect(read.messages[1]?.toolCallId).toBe('call-4');
  expect(read.stats).toEqual({
    messages: 3,
    user: 2,
    assistant: 1,
    toolCalls: 1,
    thinking: 1,
  });
});

test('a native cursor answers what came after it, and before pages backward', () => {
  const entries = Array.from({ length: 6 }, (_, i) =>
    entry(i % 2 === 0 ? 'user' : 'assistant', `i${i + 1}`, `m${i + 1}`),
  );
  const afterCursor = nativeTranscriptWindow('opencode', entries, { tail: 3, cursor: 3 });
  expect(afterCursor.messages.map((m) => m.seq)).toEqual([4, 5, 6]);
  const before = nativeTranscriptWindow('opencode', entries, {
    tail: 10,
    before: 5,
    limit: 2,
  });
  expect(before.messages.map((m) => m.seq)).toEqual([3, 4]);
  expect(before.reachedStart).toBe(false);
});

test('a textless native part is dropped without shifting the absolute seq', () => {
  const entries = [
    entry('user', 'i1', 'question'),
    entry('other', 'i2', null),
    entry('assistant', 'i3', 'answer'),
  ];
  const read = nativeTranscriptWindow('opencode', entries, { tail: 50 });
  expect(read.messages.map((m) => m.seq)).toEqual([1, 3]);
  expect(read.totalLines).toBe(3);
});

test('a complete short native conversation reports its own start', () => {
  const read = nativeTranscriptWindow('custom', [entry('user', 'i1', 'hi')], { tail: 50 });
  expect(read.reachedStart).toBe(true);
  expect(read.firstLine).toBe(1);
  expect(read.messages).toHaveLength(1);
});

async function nativeFixture() {
  const m = makeMachine({
    stateDir: mkdtempSync('/tmp/ccmux-native-transcript-'),
    rcPrefix: 'host-a',
  });
  const session = makeSession({
    name: 'native-a',
    agent: 'opencode',
    runtime: 'native',
    registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: 'opencode', id: 'ses_native_a', version: '1.18.20' },
  });
  privateRuntimeDirectory(managedRuntimeRoot(m, session));
  const projection = new OpenCodeProjection(m, session, process.pid);
  projection.status({ type: 'idle' });
  await new ManagedRuntimeStatusWriter(m, session).write(projection.snapshot());
  return {
    m,
    session,
    generation: projection.snapshot().generation,
    cleanup: () => rmSync(m.stateDir, { recursive: true, force: true }),
  };
}

test('a codex app-server session keeps its real rollout file, not the native feed', async () => {
  const root = mkdtempSync('/tmp/ccmux-codex-transcript-');
  const storage = join(root, 'sessions');
  mkdirSync(storage, { recursive: true });
  const uuid = '11111111-1111-4111-8111-111111111111';
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: root } }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-01T00:00:00.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'output_text', text: 'hello from the rollout' }],
      },
    }),
  ];
  writeFileSync(join(storage, `rollout-test-${uuid}.jsonl`), `${lines.join('\n')}\n`, {
    mode: 0o600,
  });
  const m = makeMachine({ stateDir: join(root, 'state'), codexSessionsDir: storage });
  const session = makeSession({ name: 'codex-a', agent: 'codex', runtime: 'app-server', uuid });
  try {
    const read = await readTranscriptWindow(m, session, { tail: 10 });
    expect(read.source).toBe('file');
    expect(read.path.endsWith(`${uuid}.jsonl`)).toBe(true);
    expect(read.messages.some((row) => row.text === 'hello from the rollout')).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function drive<T>(
  read: Promise<T>,
  f: Awaited<ReturnType<typeof nativeFixture>>,
  api: NativeContextApi,
  signal: AbortSignal,
): Promise<T> {
  let settled = false;
  void read.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (!settled) {
    if (Date.now() > deadline) throw new Error('native transcript read did not settle');
    await applyContextCommands(f.m, f.session, f.generation, api, signal);
    await Bun.sleep(10);
  }
  return read;
}

test('an openCode transcript read pages the native feed and orders it chronologically', async () => {
  const f = await nativeFixture();
  let calls = 0;
  const api: NativeContextApi = {
    history: async () => {
      calls++;
      // Newest page first: it holds the newest entries, ordered oldest-first within the page, and
      // points back at the older page.
      if (calls === 1)
        return boundedHistoryPage(
          f.m,
          f.session,
          [entry('user', 'i3', 'second question'), entry('assistant', 'i4', 'second answer')],
          'older-page',
          'more',
        );
      return boundedHistoryPage(
        f.m,
        f.session,
        [entry('user', 'i1', 'first question'), entry('assistant', 'i2', 'first answer')],
        null,
        'complete',
      );
    },
    compactionMarker: async () => null,
    compact: async () => {},
  };
  const controller = new AbortController();
  try {
    const answer = await drive(
      readTranscriptWindow(f.m, f.session, { tail: 50 }, controller.signal),
      f,
      api,
      controller.signal,
    );
    expect(answer.source).toBe('native');
    expect(answer.available).toBe(true);
    expect(answer.reachedStart).toBe(true);
    expect(answer.stats).toMatchObject({ messages: 4, user: 2, assistant: 2 });
    expect(answer.messages.map((m) => m.text)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
    expect(calls).toBe(2);
  } finally {
    controller.abort();
    f.cleanup();
  }
});

test('control and CLI builder keep the appended native item after eighteen mailbox pages', async () => {
  const f = await nativeFixture();
  await appendSession(f.m, f.session);
  let size = 1100;
  const api: NativeContextApi = {
    history: async (query) => {
      const end =
        query.cursor === undefined ? size : Number(historyCursor(f.m, f.session, query.cursor));
      const start = Math.max(0, end - 64);
      return boundedHistoryPage(
        f.m,
        f.session,
        Array.from({ length: end - start }, (_, i) =>
          entry('user', `i${start + i + 1}`, `m${start + i + 1}`),
        ),
        start === 0 ? null : String(start),
        start === 0 ? 'complete' : 'more',
      );
    },
    compactionMarker: async () => null,
    compact: async () => {},
  };
  const signal = AbortSignal.timeout(5_000);
  try {
    const first = await drive(
      readControlTranscript(
        f.m,
        ControlTranscriptReadSchema.parse({
          target: managedPeer(f.m.rcPrefix, f.session),
          tail: 2,
        }),
        signal,
      ),
      f,
      api,
      signal,
    );
    expect(first.cursor.line).toBe(1100);
    if (first.cursor.line === null) throw new Error('native cursor missing');
    expect(first.messages.map((item) => item.id)).toEqual(['i1099', 'i1100']);
    size++;
    const next = await drive(
      transcriptJson(f.m, f.session, { tail: 2, cursor: first.cursor.line }, signal),
      f,
      api,
      signal,
    );
    expect(next.source.available).toBe(true);
    expect(next.cursor.line).toBe(1101);
    expect(next.messages.map((item) => [item.id, item.seq])).toEqual([['i1101', 1101]]);
  } finally {
    f.cleanup();
  }
});

test('native history cancellation releases a waiter without releasing the holder first', async () => {
  const f = await nativeFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withDirectoryLock(contextPath(f.m, f.session, 'history-reader.lock'), async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    const cancellation = new AbortController();
    const waiting = readNativeHistory(f.m, f.session, { limit: 1 }, cancellation.signal);
    cancellation.abort(new Error('reader cancelled'));
    await expect(waiting).rejects.toThrow('reader cancelled');
  } finally {
    release.resolve();
    await holder;
    f.cleanup();
  }
}, 1000);

test('a native read whose feed fails answers unavailable, not an empty conversation', async () => {
  const f = await nativeFixture();
  const api: NativeContextApi = {
    history: async () => {
      throw new Error('private runtime cause');
    },
    compactionMarker: async () => null,
    compact: async () => {},
  };
  const controller = new AbortController();
  try {
    const answer = await drive(
      readTranscriptWindow(f.m, f.session, { tail: 50 }, controller.signal),
      f,
      api,
      controller.signal,
    );
    expect(answer.available).toBe(false);
    expect(answer.source).toBe('native');
    expect(answer.error).toBe('native history unavailable');
    expect(answer.messages).toEqual([]);
    // The internal cause stays internal; the answer names the state, not the provider's error.
    expect(JSON.stringify(answer)).not.toContain('private runtime cause');
  } finally {
    controller.abort();
    f.cleanup();
  }
});
