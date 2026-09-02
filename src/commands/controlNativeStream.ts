import { once } from 'node:events';
import { createControlClient } from '../control/client.ts';
import {
  CCMUX_NATIVE_STREAM_HEARTBEAT_MS,
  CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
  ControlNativeStreamRequestSchema,
  controlNativeStreamFrame,
  NativeStreamFrameUnrepresentable,
  readControlNativeStreamCursor,
} from '../control/nativeStreamContract.ts';
import type { ControlNativeSnapshot } from '../control/schema.ts';

async function boundedStdin(maxBytes: number): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Native stream input exceeds its byte budget');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function writeFrame(snapshot: ControlNativeSnapshot): Promise<void> {
  const line = `${JSON.stringify(controlNativeStreamFrame(snapshot))}\n`;
  if (!process.stdout.write(line)) await once(process.stdout, 'drain');
}

/**
 * Why the refusal says whether repeating it can help.
 *
 * A consumer reconnects on a dead stream, and that is right for a stream that could not be opened.
 * It is wrong for a frame the wire cannot carry: the reconnect fetches the same line and dies on
 * it again, forever, showing the human a conversation that is merely "queued" while the session
 * behind it answers normally. One such loop ran for twenty-two hours. Nothing here can stop a
 * consumer from retrying, but it can stop being silent about which of the two this is.
 */
export function streamRefusal(error: unknown): { error: string; retryable: boolean } {
  if (error instanceof NativeStreamFrameUnrepresentable)
    return { error: 'FRAME_UNREPRESENTABLE', retryable: false };
  if (error instanceof Error && error.message.includes('byte budget'))
    return { error: 'INPUT_TOO_LARGE', retryable: false };
  return { error: 'STREAM_UNAVAILABLE', retryable: true };
}

/** Fixed stdin contract + stable cursor; no caller argv, path, credential or provider process. */
export async function cmdControlNativeStream(): Promise<number> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const client = createControlClient();
  try {
    const input = ControlNativeStreamRequestSchema.parse(
      JSON.parse(await boundedStdin(CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES)),
    );
    const resume = readControlNativeStreamCursor(input.cursor, input.target);
    const stream = await client.watchNative.withOptions(
      { target: input.target, cursor: resume },
      { signal: abort.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();
    let pending = iterator.next();
    let last: ControlNativeSnapshot | null = null;
    while (!abort.signal.aborted) {
      const outcome = await Promise.race([
        pending.then((value) => ({ kind: 'item' as const, value })),
        Bun.sleep(CCMUX_NATIVE_STREAM_HEARTBEAT_MS).then(() => ({ kind: 'heartbeat' as const })),
      ]);
      if (outcome.kind === 'heartbeat') {
        if (last !== null) {
          if (Date.parse(last.expiresAt) <= Date.now())
            throw new Error('Native stream lease expired');
          await writeFrame(last);
        }
        continue;
      }
      if (outcome.value.done) break;
      last = outcome.value.value;
      await writeFrame(last);
      pending = iterator.next();
    }
    return 0;
  } catch (error) {
    if (abort.signal.aborted) return 0;
    process.stderr.write(`${JSON.stringify(streamRefusal(error))}\n`);
    return 1;
  } finally {
    abort.abort();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await client.close();
  }
}
