import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readControlDirectory } from '../src/control/directories.ts';
import { ControlDirectoryReadSchema } from '../src/control/directorySchema.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/ccmux-directory-test-'));
  roots.push(root);
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'b'), 'not returned');
  writeFileSync(join(root, '.hidden'), 'secret-like-fixture');
  symlinkSync(join(root, 'a'), join(root, 'c'));
  return root;
}
const read = (input: unknown) =>
  readControlDirectory(ControlDirectoryReadSchema.parse(input), AbortSignal.timeout(5000));
test('directory listing paginates names, omits hidden entries and reports but refuses symlinks', async () => {
  const path = fixture();
  const first = await read({ path, limit: 2 });
  expect(first.entries.map((e) => [e.name, e.kind])).toEqual([
    ['a', 'dir'],
    ['b', 'file'],
  ]);
  const second = await read({ path, limit: 2, cursor: first.nextCursor });
  expect(second.entries.map((e) => [e.name, e.kind])).toEqual([['c', 'symlink']]);
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify(await read({ path, includeHidden: true }))).not.toContain(
    'secret-like-fixture',
  );
  await expect(read({ path: join(path, 'c') })).rejects.toMatchObject({ code: 'SYMLINK_REFUSED' });
  await expect(read({ path: join(path, 'c', 'child') })).rejects.toMatchObject({
    code: 'SYMLINK_REFUSED',
  });
});
test('directory mutation and different selectors invalidate cursors rather than skip entries', async () => {
  const path = fixture();
  const first = await read({ path, limit: 1 });
  await expect(read({ path, cursor: first.nextCursor, includeHidden: true })).rejects.toMatchObject(
    { code: 'STALE_CURSOR' },
  );
  writeFileSync(join(path, 'aa'), '');
  await expect(read({ path, cursor: first.nextCursor })).rejects.toMatchObject({
    code: 'STALE_CURSOR',
  });
  await expect(read({ path, cursor: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
});
test('directory errors and bounds stay explicit and contain no file contents', async () => {
  const path = fixture();
  await expect(read({ path: join(path, 'absent') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(read({ path: join(path, 'b') })).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' });
  expect(ControlDirectoryReadSchema.safeParse({ limit: 513 }).success).toBe(false);
  const signal = AbortSignal.abort();
  await expect(
    readControlDirectory(ControlDirectoryReadSchema.parse({ path }), signal),
  ).rejects.toBeDefined();
});
