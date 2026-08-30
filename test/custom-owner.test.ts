import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  nativeResponseFingerprint,
  readNativeReceipt,
  writeNativeCommand,
} from '../src/agent/codex/ownedControl.ts';
import { CustomOwner } from '../src/agent/custom/owner.ts';
import { prepareMessageOperation, readMessageJournal } from '../src/chat/messageOperationStore.ts';
import { readRuntimeInput, writeRuntimeInput } from '../src/runtime/input.ts';
import { seedNativeSelection } from '../src/runtime/selection.ts';
import { customFixture, textStream, usage } from './custom-fixture.ts';
import { makeCli } from './helpers.ts';

test('managed Custom owner retains original turn, exact approval successor and one effect across reopen', async () => {
  const { m, s, host, root } = await customFixture();
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'write-once',
              toolName: 'write_file',
              input: JSON.stringify({
                path: 'owner-effect.txt',
                content: 'once',
                overwrite: false,
              }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ],
        }),
      },
      textStream(),
    ],
  });
  const errors: unknown[] = [];
  let owner = new CustomOwner(m, s, async (error) => {
    errors.push(error);
  });
  const provider = { create: () => model };
  const messageId = crypto.randomUUID();
  await seedNativeSelection(m, s, { runtime: 'custom', model: host.config.defaultModel });
  const tickUntil = async (predicate: () => boolean) => {
    for (let n = 0; n < 200; n++) {
      await owner.tick();
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error('Native transition did not settle');
  };
  await owner.open(provider);
  try {
    prepareMessageOperation(m, s, makeCli(), messageId, 'a'.repeat(64));
    await writeRuntimeInput(m, s, {
      messageId,
      nativeId: messageId,
      text: 'write',
      phase: 'queued',
    });
    await tickUntil(() => owner.projection.snapshot().state === 'waiting-approval');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(readMessageJournal(m, s)?.records[0]?.phase).toBe('admitted');
    expect(await Bun.file(join(root, 'owner-effect.txt')).exists()).toBe(false);
    await owner.close();
    owner = new CustomOwner(m, s, async (error) => {
      errors.push(error);
    });
    await owner.open(provider);
    const snapshot = owner.projection.snapshot();
    expect(snapshot.state).toBe('waiting-approval');
    const request = snapshot.pendingRequests[0];
    if (!request) throw new Error('No pending request');
    const command = {
      operationId: crypto.randomUUID(),
      generation: snapshot.generation,
      requestId: request.requestId,
      kind: 'approval',
      decision: 'accept',
      answers: null,
    } satisfies Parameters<typeof nativeResponseFingerprint>[0] & { operationId: string };
    await writeNativeCommand(m, s.name, {
      ...command,
      fingerprint: nativeResponseFingerprint(command),
    });
    await tickUntil(() => readRuntimeInput(m, s)?.terminal === 'completed');
    const record = readMessageJournal(m, s)?.records[0];
    expect(record?.turnId).toBe(messageId);
    expect(record?.phase).toBe('completed');
    expect(record?.continuations).toHaveLength(1);
    expect(record?.continuations[0]?.parentTurnId).toBe(messageId);
    expect(record?.continuations[0]?.responseOperationId).toBe(command.operationId);
    expect(record?.continuations[0]?.turnId).not.toBe(messageId);
    expect(readNativeReceipt(m, s.name)?.outcome).toBe('submitted');
    expect(await readFile(join(root, 'owner-effect.txt'), 'utf8')).toBe('once');
    await writeNativeCommand(m, s.name, {
      ...command,
      fingerprint: nativeResponseFingerprint(command),
    });
    await owner.tick();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(errors).toEqual([]);
    const publicBytes = JSON.stringify([
      record,
      owner.projection.snapshot(),
      owner.content.buffer.snapshot(),
    ]);
    expect(publicBytes).not.toContain(host.credential);
    expect(publicBytes).not.toContain(host.approvalSecret);
    expect(publicBytes).not.toContain(root);
  } finally {
    await owner.close();
  }
});
