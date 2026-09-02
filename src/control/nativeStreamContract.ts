import { z } from 'zod';
import { managedPeerKey } from '../chat/identity.ts';
import { ManagedPeerSchema } from '../config/schema.ts';
import {
  CONTROL_MAX_BYTES,
  ControlNativeCursorSchema,
  ControlNativeSnapshotSchema,
} from './schema.ts';

export const CCMUX_NATIVE_STREAM_PROFILE = 'ccmux-native';
export const CCMUX_NATIVE_STREAM_COMMAND = 'control-native-stream';
export const CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES = 4096;
export const CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES = CONTROL_MAX_BYTES + 1024;
export const CCMUX_NATIVE_STREAM_HEARTBEAT_MS = 2000;

const ControlNativeStreamCursorPayloadSchema = z
  .object({
    v: z.literal(2),
    target: ManagedPeerSchema,
    cursor: ControlNativeCursorSchema,
  })
  .strict();

const ControlNativeStreamCursorTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^ccn_[A-Za-z0-9_-]+$/);

export const ControlNativeStreamRequestSchema = z
  .object({
    target: ManagedPeerSchema,
    cursor: ControlNativeStreamCursorTokenSchema.nullable().default(null),
  })
  .strict();
export type ControlNativeStreamRequest = z.output<typeof ControlNativeStreamRequestSchema>;

export const ControlNativeStreamCursorSchema = ControlNativeStreamCursorTokenSchema.transform(
  (token, ctx) => {
    try {
      const encoded = token.slice(4).replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - (encoded.length % 4)) % 4);
      const binary = atob(encoded + padding);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return ControlNativeStreamCursorPayloadSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid native stream cursor' });
      return z.NEVER;
    }
  },
);

/**
 * The bytes a consumer actually reads: the serialized frame plus the newline that delimits it.
 *
 * This is the quantity the budget was always about, and it is NOT the size of `data`. `data` is
 * itself JSON, so serializing the frame escapes it a second time — every quote and backslash inside
 * grows again — and content carrying code or JSON is escaped twice over. Measured on a payload
 * exactly at the budget: 525_312 bytes of `data` became a 605_332-byte line, 80_020 over.
 */
export function controlNativeStreamFrameBytes(frame: unknown): number {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`).byteLength;
}

export const ControlNativeStreamFrameSchema = z
  .object({
    channel: z.literal('data'),
    data: z.string(),
    cursor: ControlNativeStreamCursorTokenSchema,
  })
  .strict()
  // Checked on the LINE, not on `data`. Checking the payload and enforcing on the wire is one
  // number answering two different questions, and the gap between them is where a frame nobody
  // could parse got through: the consumer's framed reader hit its buffer bound, died, reconnected,
  // received the same line and died again — a retry loop that cannot converge, because a retry
  // makes nothing smaller. A conversation showed as queued for twenty-two hours behind it.
  .refine(
    (frame) => controlNativeStreamFrameBytes(frame) <= CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
    'native stream frame exceeds byte budget',
  );

export function encodeControlNativeStreamCursor(
  target: z.output<typeof ManagedPeerSchema>,
  cursor: z.output<typeof ControlNativeCursorSchema>,
): string {
  const payload = JSON.stringify(
    ControlNativeStreamCursorPayloadSchema.parse({ v: 2, target, cursor }),
  );
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `ccn_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

export function readControlNativeStreamCursor(
  token: string | null,
  target: z.output<typeof ManagedPeerSchema>,
): z.output<typeof ControlNativeCursorSchema> | null {
  if (token === null) return null;
  const parsed = ControlNativeStreamCursorSchema.parse(token);
  if (managedPeerKey(parsed.target) !== managedPeerKey(target))
    throw new Error('Native stream cursor belongs to another target');
  return parsed.cursor;
}

/**
 * A frame that fits the budget the consumer enforces, shedding observation until it does.
 *
 * The snapshot is an observation cache, and `omittedRecords` is how it already says "there was more
 * than this". So an oversized frame has an honest smaller form, and sending it is strictly better
 * than sending one that cannot be read: a frame over the bound does not degrade the consumer, it
 * kills the stream, and the reconnect that follows fetches the same line again.
 *
 * Oldest records go first, then baseline entries, each counted into `omittedRecords` — the same
 * order and the same accounting the buffer uses when it sheds under its own bounds. Sizes are
 * measured rather than predicted: how much a record costs on the wire depends on what its text
 * contains, and the escaping ratio is not a constant to multiply by.
 */
export function controlNativeStreamFrame(snapshot: unknown) {
  const native = ControlNativeSnapshotSchema.parse(snapshot);
  const cursor = encodeControlNativeStreamCursor(native.target, {
    generation: native.generation,
    sequence: native.sequence,
  });
  const build = (
    records: typeof native.records,
    baseline: typeof native.baseline,
    omittedRecords: number,
  ) => ({
    channel: 'data' as const,
    data: JSON.stringify({ ...native, records, baseline, omittedRecords }),
    cursor,
  });

  // How many of the newest entries fit, found by halving rather than by dropping one at a time.
  // The frame only shrinks as entries are removed, so the answer is monotonic and a binary search
  // is exact — and the difference is not academic: shedding singly cost 4.5 SECONDS on a
  // two-megabyte snapshot, because each step re-serializes the whole thing. Nine measurements
  // instead of four hundred and twenty-four.
  const fits = (records: typeof native.records, baseline: typeof native.baseline) =>
    controlNativeStreamFrameBytes(
      build(records, baseline, native.omittedRecords + (native.records.length - records.length)),
    ) <= CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES;
  const keepNewest = <T>(items: readonly T[], count: number) => items.slice(items.length - count);

  let records = native.records;
  let baseline = native.baseline;
  if (!fits(records, baseline)) {
    let low = 0;
    let high = records.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(keepNewest(native.records, middle), baseline)) low = middle;
      else high = middle - 1;
    }
    records = keepNewest(native.records, low);
    if (low === 0 && !fits(records, baseline)) {
      let lowBaseline = 0;
      let highBaseline = baseline.length;
      while (lowBaseline < highBaseline) {
        const middle = Math.ceil((lowBaseline + highBaseline) / 2);
        if (fits(records, keepNewest(native.baseline, middle))) lowBaseline = middle;
        else highBaseline = middle - 1;
      }
      baseline = keepNewest(native.baseline, lowBaseline);
    }
  }
  // Everything shed is counted, and only what was actually shed. If nothing observational is left
  // and the fixed fields alone are over budget there is no honest smaller frame to send, so the
  // schema refuses rather than emitting one that would end the consumer's stream.
  const shed = native.records.length - records.length + (native.baseline.length - baseline.length);
  return ControlNativeStreamFrameSchema.parse(
    build(records, baseline, native.omittedRecords + shed),
  );
}

export const CcmuxNativeStreamProfileSchema = z
  .object({
    bin: z.string().startsWith('/'),
    argv: z.tuple([z.literal(CCMUX_NATIVE_STREAM_COMMAND)]),
    callerArgs: z.object({ mode: z.literal('none') }).strict(),
    stdin: z
      .object({ mode: z.literal('text'), maxBytes: z.literal(CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES) })
      .strict(),
    env: z.object({ inherit: z.tuple([]), set: z.object({}).strict() }).strict(),
    timeoutMs: z.literal(900_000),
    maxBytes: z.literal(64 * 1024 * 1024),
    concurrency: z.literal(4),
    format: z.object({ mode: z.literal('ndjson'), stableCursor: z.literal(true) }).strict(),
  })
  .strict();

/** Operator supplies only the standard installed `ccmux` executable path. The installer publishes
 * a PATH-independent POSIX shim with absolute runtime and bundle paths, so the fixed empty
 * environment is executable without weakening the profile. argv and framing remain owner-fixed. */
export function createCcmuxNativeStreamProfile(bin: string) {
  return CcmuxNativeStreamProfileSchema.parse({
    bin,
    argv: [CCMUX_NATIVE_STREAM_COMMAND],
    callerArgs: { mode: 'none' },
    stdin: { mode: 'text', maxBytes: CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES },
    env: { inherit: [], set: {} },
    timeoutMs: 900_000,
    maxBytes: 64 * 1024 * 1024,
    concurrency: 4,
    format: { mode: 'ndjson', stableCursor: true },
  });
}
