import { expect, test } from 'bun:test';
import { readImage } from '../src/agent/claude/images.ts';
import { parse } from '../src/agent/claude/transcript.ts';
import { TranscriptMessageSchema } from '../src/agent/transcript/messageSchema.ts';

const RESULT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PNG = 'iVBORw0KGgo=';
const image = (data = PNG) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});
const entry = (uuid: string, role: string, content: unknown[]) =>
  JSON.stringify({ uuid, type: role, message: { role, content } });
const result = (id: string, content: unknown[]) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});
const calls = entry('call-entry', 'assistant', [
  { type: 'tool_use', id: 'read-a', name: 'Read', input: { file_path: '/tmp/a.png' } },
  { type: 'tool_use', id: 'read-b', name: 'Read', input: { file_path: '/tmp/b.png' } },
]);
const output = entry(RESULT, 'user', [
  result('read-a', [{ type: 'text', text: 'first' }, image(), image('AQID')]),
  result('read-b', [image('BAUG')]),
  image('BwgJ'),
]);

test('tool images stay with their exact call, in source order, without inline bytes', () => {
  const messages = parse([calls, output], 1);
  const a = messages.find((m) => m.toolCallId === 'read-a');
  const b = messages.find((m) => m.toolCallId === 'read-b');
  expect(a?.resultImages?.map((i) => i.address)).toEqual([`${RESULT}#0/1`, `${RESULT}#0/2`]);
  expect(b?.resultImages?.map((i) => i.address)).toEqual([`${RESULT}#1/0`]);
  expect(a?.resultText).toContain('[image]');
  expect(messages.filter((m) => m.kind === 'tool_result')).toHaveLength(0);
  expect(messages.find((m) => m.kind === 'image')?.image?.address).toBe(`${RESULT}#2`);
  expect(JSON.stringify(messages)).not.toContain(PNG);
  expect(TranscriptMessageSchema.parse(a).resultImages).toEqual(a?.resultImages);
});

test('the descriptor addresses retrieve exact nested bytes and leave ordinary addresses intact', () => {
  expect(readImage([output], `${RESULT}#0/1`)).toEqual({ mediaType: 'image/png', data: PNG });
  expect(readImage([output], `${RESULT}#0/2`)).toEqual({ mediaType: 'image/png', data: 'AQID' });
  expect(readImage([output], `${RESULT}#1/0`)).toEqual({ mediaType: 'image/png', data: 'BAUG' });
  expect(readImage([output], `${RESULT}#2`)).toEqual({ mediaType: 'image/png', data: 'BwgJ' });
});

test('a result-only window and a tiny text limit keep the same addresses', () => {
  const full = parse([calls, output], 1);
  const tail = parse([output], 2, 1, undefined, 2);
  const a = tail.find((m) => m.toolCallId === 'read-a');
  expect(a?.kind).toBe('tool_result');
  expect(a?.seq).toBe(2);
  expect(a?.resultImages).toEqual(full.find((m) => m.toolCallId === 'read-a')?.resultImages);
  expect(a?.resultImages).toHaveLength(2);
});

test('text-only results do not materialize a new field', () => {
  const [message] = parse(
    [calls, entry(RESULT, 'user', [result('read-a', [{ type: 'text', text: 'ok' }])])],
    1,
  );
  expect(message?.resultText).toBe('ok');
  expect(message).not.toHaveProperty('resultImages');
  expect(TranscriptMessageSchema.parse(message)).not.toHaveProperty('resultImages');
});

test('image metadata reports decoded size and refuses invalid base64', () => {
  const lines = entry(RESULT, 'user', [result('read-a', [image(), image('abc!')])]);
  const [message] = parse([lines], 1);
  expect(message?.resultImages?.[0]?.bytes).toBe(Buffer.from(PNG, 'base64').length);
  expect(message?.resultImages?.[1]?.unavailable).toBe('malformed');
  expect(readImage([lines], `${RESULT}#0/1`)).toEqual({ unavailable: 'malformed' });
});

test('image read refuses malformed addresses rather than interpreting a prefix', () => {
  for (const suffix of [
    '0junk',
    '0/1junk',
    '0/1/2',
    '-1/1',
    '0/0.5',
    '2/0',
    '0',
    '0/99',
    '999999999999999999999',
  ]) {
    expect(readImage([output], `${RESULT}#${suffix}`)).toEqual({ unavailable: 'malformed' });
  }
  expect(readImage([], `${RESULT}#0/1`)).toEqual({ unavailable: 'malformed' });
});

test('unavailable images keep descriptors and their reader uses the same refusal', () => {
  const refused = entry(RESULT, 'user', [
    result('read-a', [
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/image' } },
      { type: 'image', source: { type: 'base64' } },
      image('A'.repeat(12 * 1024 * 1024)),
    ]),
  ]);
  const [message] = parse([refused], 1);
  expect(message?.resultImages?.map((i) => i.unavailable)).toEqual([
    'unsupported-source',
    'malformed',
    'too-large',
  ]);
  for (const descriptor of message?.resultImages ?? []) {
    expect(readImage([refused], descriptor.address)).toEqual({
      unavailable: descriptor.unavailable,
    });
  }
});
