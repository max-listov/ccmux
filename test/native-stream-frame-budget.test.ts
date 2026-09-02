import { expect, test } from 'bun:test';
import {
  CCMUX_NATIVE_STREAM_MAX_CHUNK_BYTES,
  CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  controlNativeStreamFrame,
  controlNativeStreamFrameBytes,
} from '../src/control/nativeStreamContract.ts';

const target = {
  kind: 'managed',
  source: 'ccmux',
  agent: 'claude',
  machine: 'host-a',
  session: 'agent-a',
  threadId: '11111111-1111-4111-8111-111111111111',
} as const;

// Text that is escaped twice over — it is JSON, inside a JSON string, inside a JSON line. This is
// what real thread content looks like when it carries code, and it is why the wire size cannot be
// predicted from the payload size by multiplying.
const nasty = (size: number) =>
  JSON.stringify({ code: 'const x = "a\\b"; // "quoted"', more: 'y'.repeat(size) });

const record = (sequence: number, size: number) => ({
  sequence,
  at: '2026-09-02T09:00:00.000Z',
  kind: 'assistant' as const,
  operation: 'append' as const,
  turnId: 't1',
  itemId: `i${sequence}`,
  revision: 1,
  offsetBytes: 0,
  prefixKnown: true,
  text: nasty(size),
  totalBytes: size,
  omittedBytes: 0,
  complete: true,
  status: null,
  tool: null,
});

const snapshot = (records: number, size: number, omittedRecords = 0) => ({
  protocol: 1 as const,
  target,
  registrationGeneration: null,
  nativeId: 'n1',
  generation: '22222222-2222-4222-8222-222222222222',
  sequence: 900,
  omittedRecords,
  status: 'live' as const,
  records: Array.from({ length: records }, (_, i) => record(i + 1, size)),
  baseline: Array.from({ length: 8 }, (_, i) => record(10_000 + i, size)),
  reset: null,
  observedAt: '2026-09-02T09:00:00.000Z',
  expiresAt: '2026-09-02T09:00:10.000Z',
  pending: [],
  selection: null,
  nativeSelection: null,
});

const rawLineBytes = (value: unknown) =>
  controlNativeStreamFrameBytes({
    channel: 'data',
    data: JSON.stringify(value),
    cursor: `ccn_${'A'.repeat(400)}`,
  });

test('the frame budget is measured on the line a consumer reads, not on the payload', () => {
  // The two quantities the one number was asked to answer. `data` is itself JSON, so serializing
  // the frame escapes it a second time — the line is always larger, and by how much depends on what
  // the text contains.
  const value = snapshot(20, 100);
  const payload = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  expect(rawLineBytes(value)).toBeGreaterThan(payload);
});

test('an ordinary snapshot passes through whole', () => {
  const value = snapshot(4, 60);
  expect(rawLineBytes(value)).toBeLessThanOrEqual(CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES);
  const frame = controlNativeStreamFrame(value);
  const sent = JSON.parse(frame.data) as { records: unknown[]; omittedRecords: number };
  expect(sent.records).toHaveLength(4);
  // Nothing was shed, so nothing is counted as shed. A shed count invented for a shed that did not
  // happen is the same lie as any other invented number.
  expect(sent.omittedRecords).toBe(0);
});

test('a snapshot too large for the line is shed until it fits, and says how much', () => {
  const value = snapshot(512, 300, 7);
  // The fixture has to actually reach the condition: a probe that never crosses the budget would
  // report success without exercising anything. This threw during development, twice.
  expect(rawLineBytes(value)).toBeGreaterThan(CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES);

  const frame = controlNativeStreamFrame(value);
  expect(controlNativeStreamFrameBytes(frame)).toBeLessThanOrEqual(
    CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  );

  const sent = JSON.parse(frame.data) as {
    records: { sequence: number }[];
    omittedRecords: number;
  };
  expect(sent.records.length).toBeGreaterThan(0);
  expect(sent.records.length).toBeLessThan(512);
  // Exactly what was dropped, added to what the snapshot already carried.
  expect(sent.omittedRecords).toBe(7 + (512 - sent.records.length));
  // The NEWEST survive: an observation cache that shed its latest entries would be reporting the
  // past as the present.
  expect(sent.records[sent.records.length - 1]?.sequence).toBe(512);
  expect(sent.records[0]?.sequence).toBe(512 - sent.records.length + 1);
});

test('shedding is found by halving, not by dropping one at a time', () => {
  // Not a preference. Dropping singly re-serializes the whole snapshot each step and cost 4.5
  // seconds on a two-megabyte frame — on a path that emits frames continuously. This bound is
  // generous enough not to fail on a loaded machine and far below what the linear form took.
  const value = snapshot(512, 300);
  const started = performance.now();
  controlNativeStreamFrame(value);
  expect(performance.now() - started).toBeLessThan(1_500);
});

test("the budget comes from the wire under it, not from this project's own constant", () => {
  // Read from the transport's source rather than inferred: it buffers the producer's NDJSON at
  // `maxChunkBytes * 2` and separately refuses a framed chunk whose `data` exceeds `maxChunkBytes`.
  // That knob's schema maximum and its default are both 32 KiB, so no deployment carries more.
  expect(CCMUX_NATIVE_STREAM_MAX_CHUNK_BYTES).toBe(32 * 1024);
  expect(CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES).toBe(2 * CCMUX_NATIVE_STREAM_MAX_CHUNK_BYTES);

  // The earlier value was this project's own 513 KiB — eight times what the wire carries — and a
  // frame sized against it satisfied the contract and died on the wire. This pins the relationship
  // so the number cannot drift back to one nobody on the wire enforces.
  expect(CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES).toBeLessThan(512 * 1024);
});

test('both ceilings are enforced, because the transport applies both', () => {
  const value = snapshot(512, 300);
  const frame = controlNativeStreamFrame(value);
  // The line, which is what the parser buffers.
  expect(controlNativeStreamFrameBytes(frame)).toBeLessThanOrEqual(
    CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  );
  // And the payload, which the chunk check measures separately. A frame can clear one alone, so
  // clearing one is not evidence about the other.
  expect(new TextEncoder().encode(frame.data).byteLength).toBeLessThanOrEqual(
    CCMUX_NATIVE_STREAM_MAX_CHUNK_BYTES,
  );
});
