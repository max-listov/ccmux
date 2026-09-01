import { expect, test } from 'bun:test';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';
import { RewindResultSchema } from '../src/runtime/rewindSchema.ts';

/**
 * Putting the files back. What matters here is the difference between "nothing was refused" and
 * "nobody measured refusals" — a rewind that quietly skipped a file would tell a person their tree
 * is back when part of it is not.
 */

test('a preview reports no refusal count, because only a real rewind can have one', () => {
  const preview = RewindResultSchema.parse({
    canRewind: true,
    error: null,
    filesChanged: ['/Users/u/src/a.ts'],
    insertions: 1,
    deletions: 1,
    skippedLinks: null,
  });
  expect(preview.skippedLinks).toBeNull();
  expect(preview.filesChanged).toEqual(['/Users/u/src/a.ts']);
});

test('a real rewind distinguishes no refusals from unmeasured', () => {
  const clean = RewindResultSchema.parse({
    canRewind: true,
    error: null,
    filesChanged: [],
    insertions: null,
    deletions: null,
    skippedLinks: 0,
  });
  // Zero is a measurement: nothing was refused. Null would be "nobody looked".
  expect(clean.skippedLinks).toBe(0);
  const refused = RewindResultSchema.parse({
    canRewind: true,
    error: null,
    filesChanged: [],
    insertions: null,
    deletions: null,
    skippedLinks: 2,
  });
  expect(refused.skippedLinks).toBe(2);
});

test('a refusal to rewind carries its reason rather than an empty success', () => {
  const result = RewindResultSchema.parse({
    canRewind: false,
    error: 'checkpointing is not enabled',
    filesChanged: [],
    insertions: null,
    deletions: null,
    skippedLinks: null,
  });
  expect(result.canRewind).toBe(false);
  expect(result.error).toBe('checkpointing is not enabled');
});

test('checkpoints are declared for the native mode alone', () => {
  expect(runtimeCapabilities({ agent: 'claude', runtime: 'native' }).fileCheckpoints).toBe(true);
  expect(runtimeCapabilities({ agent: 'claude', runtime: 'tui' }).fileCheckpoints).toBe(false);
  expect(runtimeCapabilities({ agent: 'codex' }).fileCheckpoints).toBe(false);
});
