import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { boundedOpenCodeFetch, OPENCODE_HTTP_MAX_BYTES } from '../src/agent/opencode/http.ts';
import { InlineImageElider } from '../src/agent/opencode/imageElision.ts';

function project(value: string, chunk = 1) {
  const elider = new InlineImageElider(),
    bytes = Buffer.from(value),
    output: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunk)
    for (const byte of bytes.subarray(offset, offset + chunk))
      elider.feed(byte, (part) => output.push(part));
  elider.finish((byte) => output.push(byte));
  return Buffer.from(output).toString();
}

test('native image elision preserves JSON byte boundaries and unrelated strings', () => {
  const original = {
    info: { id: 'msg_example', role: 'user' },
    parts: [
      {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,Aa0+/==',
        filename: 'fixture.png',
      },
      { type: 'text', text: '🙂 "url":"data:image/png;base64,Aa"' },
      { type: 'file', url: 'file:///example.png' },
      { type: 'file', url: 'https://example.invalid/image.png' },
      { url: 'url', after: 'data:image/png;base64,keep' },
    ],
  };
  const expected = structuredClone(original);
  assert(expected.parts[0]);
  expected.parts[0].url = 'ccmux-inline-image:omitted';
  for (const chunk of [1, 2, 7, 31, 1024])
    expect(JSON.parse(project(JSON.stringify(original), chunk))).toEqual(expected);
  for (const value of ['url', '', 'data:', 'data:image/webp;base64,AA', 'url\\"🙂'])
    expect(project(JSON.stringify({ url: value }))).toBe(JSON.stringify({ url: value }));
});

test('native elision rejects malformed/truncated image values', () => {
  expect(() => project('{"url":"data:image/png;base64,AAA')).toThrow('truncated');
  expect(() => project('{"url":"data:image/png;base64,AA?"}')).toThrow('encoding');
  expect(() => project('{"url":"data:image/jpeg;base64,AA\\nAA"}')).toThrow('encoding');
});

test('large native image echo is bounded before SDK JSON without widening non-image bytes', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const key = new URL(request.url).pathname === '/text' ? 'text' : 'url';
      return Response.json({
        type: 'file',
        [key]: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`,
        mime: 'image/png',
      });
    },
  });
  try {
    const result = await (await boundedOpenCodeFetch(server.url)).json();
    expect(result).toEqual({ type: 'file', url: 'ccmux-inline-image:omitted', mime: 'image/png' });
    expect(JSON.stringify(result).length).toBeLessThan(OPENCODE_HTTP_MAX_BYTES);
    await expect((await boundedOpenCodeFetch(new URL('/text', server.url))).text()).rejects.toThrow(
      'bounded frame',
    );
  } finally {
    await server.stop(true);
  }
});
