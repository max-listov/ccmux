import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateJson } from '../src/runtime/store.ts';

test('private snapshots keep callers separate and observe replacement, permissions and links', () => {
  const root = mkdtempSync('/tmp/ccmux-private-snapshot-');
  const path = join(root, 'command.json');
  const schema = z.object({ value: z.number(), nested: z.unknown() }).strict();
  const put = (value: number) =>
    writeFileSync(path, JSON.stringify({ value, nested: { a: 1 } }), { mode: 0o600 });
  try {
    put(1);
    const first = readPrivateJson(path, schema);
    expect(first?.value).toBe(1);
    first && Object.assign(first.nested ?? {}, { a: 9 });
    expect(readPrivateJson(path, schema)?.nested).toEqual({ a: 1 });
    put(2);
    expect(readPrivateJson(path, schema)?.value).toBe(2);
    writeFileSync(join(root, 'next'), JSON.stringify({ value: 3, nested: {} }), { mode: 0o600 });
    renameSync(join(root, 'next'), path);
    expect(readPrivateJson(path, schema)?.value).toBe(3);
    expect(readPrivateJson(path, schema, 2)).toBeNull();
    chmodSync(path, 0o644);
    expect(readPrivateJson(path, schema)).toBeNull();
    chmodSync(path, 0o600);
    renameSync(path, join(root, 'target'));
    symlinkSync(join(root, 'target'), path);
    expect(readPrivateJson(path, schema)).toBeNull();
    rmSync(path);
    expect(readPrivateJson(path, schema)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
