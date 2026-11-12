import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogFrame } from '../src/chat/feedSchema.ts';
import { appendMessage } from '../src/chat/ledger.ts';
import { followLog, ZERO_CURSOR } from '../src/chat/logFeed.ts';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { makeChatMessage, makeMachine } from './helpers.ts';

/** The next `count` frames of a stream, read without closing it. */
async function take(frames: AsyncIterator<LogFrame>, count: number): Promise<LogFrame[]> {
  const taken: LogFrame[] = [];
  while (taken.length < count) {
    const next = await frames.next();
    if (next.done) break;
    taken.push(next.value);
  }
  return taken;
}

test('a program follows the chat log through the client, from the frames the command prints', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmux-chat-stream-')));
  const m = makeMachine({ rcPrefix: 'host-a', stateDir: join(root, 'state') });
  const publisher = new ControlPublisher(m);
  const server = createControlServer(m, publisher);
  const client = createControlClient({ socket: controlSocket(m) });
  const abort = new AbortController();
  try {
    appendMessage(m, makeChatMessage({ body: 'the heron plan' }));

    // The machine first, then what is in the log, then a row as it is written.
    const stream = (await client.watchChatLog.withOptions({}, { signal: abort.signal }))[
      Symbol.asyncIterator
    ]();
    const opening = await take(stream, 2);
    expect(opening.map((frame) => frame.kind)).toEqual(['machine', 'row']);
    expect(opening[0]).toMatchObject({ machine: { machine: 'host-a', ok: true } });
    expect(opening[1]).toMatchObject({ row: { body: 'the heron plan' } });
    appendMessage(m, makeChatMessage({ body: 'and the kestrel' }));
    const [written] = await take(stream, 1);
    expect(written).toMatchObject({ kind: 'row', row: { body: 'and the kestrel' } });
    abort.abort();

    // The command's producer gives the same frames for the same log.
    const printed: LogFrame[] = [];
    followLog(m, ZERO_CURSOR, (frame) => printed.push(frame))();
    expect(printed).toEqual([...opening, written as LogFrame]);

    // A reader resumes from the last cursor it was handed and is given only what came after.
    const later = new AbortController();
    try {
      appendMessage(m, makeChatMessage({ body: 'third' }));
      const resumed = await take(
        (
          await client.watchChatLog.withOptions(
            { since: (opening[1] as LogFrame).cursor },
            { signal: later.signal },
          )
        )[Symbol.asyncIterator](),
        3,
      );
      expect(resumed.map((frame) => (frame.kind === 'row' ? frame.row.body : 'machine'))).toEqual([
        'machine',
        'and the kestrel',
        'third',
      ]);
    } finally {
      later.abort();
    }

    // A cursor this log never gave is refused, not read as "from now".
    await expect(
      (async () => {
        for await (const _ of await client.watchChatLog({ since: 'not-a-cursor' })) break;
      })(),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    abort.abort();
    await client.close();
    publisher.close();
    await server.server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 100 });
    await server.observability.close();
    rmSync(root, { recursive: true, force: true });
  }
});
