import { z } from 'zod';
import { SELF_ARGV_NO_ENV_FILE } from '../env.ts';
import { AttachmentFault, assertAttachment } from './errors.ts';
import { type DecodedImage, DecodedImageSchema } from './imageValidation.ts';
import { ATTACHMENT_LIMITS } from './reference.ts';

const ReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), image: DecodedImageSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9-]+$/),
    })
    .strict(),
]);

async function readReply(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    assertAttachment(size <= 1024, 'decoder-response-budget');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function decodeAttachment(bytes: Buffer, signal: AbortSignal): Promise<DecodedImage> {
  signal.throwIfAborted();
  const child = Bun.spawn([...SELF_ARGV_NO_ENV_FILE, '_attachment-validate'], {
    stdin: bytes,
    stdout: 'pipe',
    stderr: 'ignore',
    env: {},
  });
  const stop = () => child.kill('SIGKILL');
  const timer = setTimeout(stop, ATTACHMENT_LIMITS.decodeDeadlineMs);
  signal.addEventListener('abort', stop, { once: true });
  try {
    const [code, output] = await Promise.all([child.exited, readReply(child.stdout)]);
    signal.throwIfAborted();
    const reply = ReplySchema.parse(JSON.parse(output));
    if (!reply.ok) throw new AttachmentFault(reply.reason);
    assertAttachment(code === 0, 'decoder-refused');
    return reply.image;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (child.exitCode === null) {
      stop();
      await child.exited;
    }
  }
}
