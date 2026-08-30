/** UTF-8 offsets refer to original native text; no chunk ends inside a code point. */
export function textChunks(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = '',
    size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > maxBytes && chunk.length) {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += point;
    size += bytes;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export function textTail(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] ?? 0) >= 0x80 && (bytes[start] ?? 0) < 0xc0) start++;
  return { text: bytes.toString('utf8', start), omittedBytes: start };
}
