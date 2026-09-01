import { expect, test } from 'bun:test';
import { imageDescriptor, parse, readImage, usageOf } from '../src/agent/claude/transcript.ts';

/**
 * What a transcript says about a picture and about what a turn cost.
 *
 * Both used to be thrown away in the same breath they were read: an image became the word
 * `[image]`, and usage was reduced to a single context number.
 */

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PNG = 'iVBORw0KGgo=';
const line = (content: unknown[], usage?: Record<string, number>) =>
  JSON.stringify({
    type: 'assistant',
    uuid: UUID,
    timestamp: '2026-09-01T10:00:00.000Z',
    message: { role: 'assistant', content, ...(usage ? { usage } : {}) },
  });

test('an image becomes an addressed message instead of the word for one', () => {
  const messages = parse(
    [line([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }])],
    1,
  );
  const image = messages[0];
  expect(image?.kind).toBe('image');
  // The word is gone: it was a picture replaced by a string nothing could turn back into one.
  expect(image?.text).toBeNull();
  expect(image?.image?.address).toBe(`${UUID}#0`);
  expect(image?.image?.mediaType).toBe('image/png');
  expect(image?.image?.unavailable).toBeNull();
  expect(image?.image?.digest).toHaveLength(64);
  // The bytes stay off the record: a listing is read constantly and wants no pictures.
  expect(JSON.stringify(image)).not.toContain(PNG);
});

test('an image that cannot be fetched says which way, and is not silence', () => {
  const url = imageDescriptor(
    { type: 'image', source: { type: 'url', url: 'https://x' } },
    UUID,
    0,
  );
  // Somebody else's to fetch; handing back an address this project cannot answer would be worse.
  expect(url.unavailable).toBe('unsupported-source');
  expect(imageDescriptor({ type: 'image', source: { type: 'base64' } }, UUID, 1).unavailable).toBe(
    'malformed',
  );
  const huge = imageDescriptor(
    { type: 'image', source: { type: 'base64', data: 'A'.repeat(20 * 1024 * 1024) } },
    UUID,
    2,
  );
  expect(huge.unavailable).toBe('too-large');
  // Size is still reported for the one that was refused: the reader is told what it was.
  expect(huge.bytes).toBeGreaterThan(0);
});

test('the bytes are readable by the address the message carried', () => {
  const lines = [
    line([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]),
  ];
  const found = readImage(lines, `${UUID}#0`);
  expect(found).toEqual({ mediaType: 'image/png', data: PNG });
  // An address nobody wrote resolves to a named failure, never to a different picture.
  expect(readImage(lines, `${UUID}#7`)).toEqual({ unavailable: 'malformed' });
  expect(readImage(lines, 'nonsense')).toEqual({ unavailable: 'malformed' });
});

test('an answer carries what it cost, and silence stays unknown rather than zero', () => {
  const [message] = parse(
    [
      line([{ type: 'text', text: 'ok' }], {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 80,
      }),
    ],
    1,
  );
  expect(message?.usage).toEqual({
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 80,
    // The source did not report this one; null says so instead of claiming none were created.
    cacheCreationTokens: null,
  });
  const [silent] = parse([line([{ type: 'text', text: 'ok' }])], 1);
  expect(silent?.usage).toBeNull();
  expect(usageOf({ message: { role: 'assistant' } })).toBeNull();
});
