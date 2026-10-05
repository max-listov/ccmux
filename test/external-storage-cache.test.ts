import { expect, spyOn, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalContentTarget } from '../src/external/contentSchema.ts';
import {
  locateExternalStorage,
  STORAGE_LOOKUP_MAX_AGE_MS,
  STORAGE_MISS_RESCAN_MS,
} from '../src/external/storage.ts';

test('known threads avoid walks; a duplicate in another directory is caught at the bounded deadline', async () => {
  const root = mkdtempSync('/tmp/ccmux-storage-cache-');
  const id = crypto.randomUUID();
  const target: ExternalContentTarget = { provider: 'codex', machine: 'host-a', threadId: id };
  for (const dir of ['a', 'b', 'unrelated']) mkdirSync(join(root, dir));
  const first = join(root, 'a', `rollout-test-${id}.jsonl`);
  writeFileSync(first, '{}\n');
  const open = spyOn(fs, 'opendir');
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    expect(await locateExternalStorage(root, target, new AbortController().signal)).toBe(first);
    expect(open.mock.calls.length).toBeGreaterThan(1);
    open.mockClear();
    for (let n = 0; n < 20; n++)
      expect(await locateExternalStorage(root, target, new AbortController().signal)).toBe(first);
    expect(open.mock.calls).toHaveLength(0);
    // Existing sibling's contents change without changing root or the known file's parent.
    writeFileSync(join(root, 'b', `rollout-copy-${id}.jsonl`), '{}\n');
    const expired = Date.now() + STORAGE_LOOKUP_MAX_AGE_MS + 1;
    clock = spyOn(Date, 'now').mockReturnValue(expired);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        locateExternalStorage(root, target, new AbortController().signal),
      ),
    );
    expect(
      results.every(
        (result) => result.status === 'rejected' && String(result.reason).includes('Ambiguous'),
      ),
    ).toBe(true);
    expect(open.mock.calls).toHaveLength(4);
  } finally {
    clock?.mockRestore();
    open.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('moving a whole cached parent directory is found without a false unavailable result', async () => {
  const root = mkdtempSync('/tmp/ccmux-storage-parent-');
  const id = crypto.randomUUID();
  const target: ExternalContentTarget = { provider: 'codex', machine: 'host-a', threadId: id };
  mkdirSync(join(root, 'live', 'day'), { recursive: true });
  mkdirSync(join(root, 'archive'));
  const name = `rollout-test-${id}.jsonl`;
  writeFileSync(join(root, 'live', 'day', name), '{}\n');
  try {
    expect(await locateExternalStorage(root, target, new AbortController().signal)).toBe(
      join(root, 'live', 'day', name),
    );
    const stamp = lstatSync(root, { bigint: true });
    renameSync(join(root, 'live', 'day'), join(root, 'archive', 'day'));
    expect(lstatSync(root, { bigint: true }).mtimeNs).toBe(stamp.mtimeNs);
    expect(await locateExternalStorage(root, target, new AbortController().signal)).toBe(
      join(root, 'archive', 'day', name),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one caller abandoning a shared walk does not fail the others waiting on it', async () => {
  const root = mkdtempSync('/tmp/ccmux-storage-abort-');
  const id = crypto.randomUUID();
  const target: ExternalContentTarget = { provider: 'codex', machine: 'host-a', threadId: id };
  mkdirSync(join(root, 'day'));
  const file = join(root, 'day', `rollout-test-${id}.jsonl`);
  writeFileSync(file, '{}\n');
  try {
    const first = new AbortController();
    const abandoned = locateExternalStorage(root, target, first.signal);
    const waiting = locateExternalStorage(root, target, new AbortController().signal);
    first.abort();
    expect(
      await abandoned.then(
        () => 'resolved',
        (error: unknown) => String(error),
      ),
    ).toContain('Abort');
    expect(await waiting).toBe(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a thread created in an existing day directory is found once the index is briefly old', async () => {
  const root = mkdtempSync('/tmp/ccmux-storage-miss-');
  const known = crypto.randomUUID();
  const fresh = crypto.randomUUID();
  const look = (threadId: string) =>
    locateExternalStorage(
      root,
      { provider: 'codex', machine: 'host-a', threadId },
      new AbortController().signal,
    );
  mkdirSync(join(root, 'day'));
  writeFileSync(join(root, 'day', `rollout-test-${known}.jsonl`), '{}\n');
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    expect(await look(known)).not.toBeNull();
    // Same day directory: the root's revision does not change.
    const file = join(root, 'day', `rollout-test-${fresh}.jsonl`);
    writeFileSync(file, '{}\n');
    clock = spyOn(Date, 'now').mockReturnValue(Date.now() + STORAGE_MISS_RESCAN_MS + 1);
    expect(await look(fresh)).toBe(file);
  } finally {
    clock?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
