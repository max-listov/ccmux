import { expect, test } from 'bun:test';
import { join } from 'node:path';

// The changelog is the release notes: CI publishes a version's section as its GitHub Release, and
// `bun run release` rolls `[Unreleased]` into it. Three shapes broke it once without any check
// noticing — a version section above `[Unreleased]`, a failed tag's section renamed away to the
// next version, and a heading with a hyphen instead of the dash the extractor reads.

const text = await Bun.file(join(import.meta.dir, '..', 'CHANGELOG.md')).text();
const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? '');
const VERSION_HEADING = /^\[(\d+)\.(\d+)\.(\d+)\] — \d{4}-\d{2}-\d{2}$/;

const versionOf = (heading: string) => {
  const match = VERSION_HEADING.exec(heading);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

test('[Unreleased] comes first, and every other section is `[X.Y.Z] — YYYY-MM-DD`', () => {
  expect(headings[0]).toBe('[Unreleased]');
  expect(headings.slice(1).filter((heading) => versionOf(heading) === null)).toEqual([]);
});

test('versions run strictly from newest to oldest', () => {
  const versions = headings.slice(1).map((heading) => versionOf(heading) ?? [0, 0, 0]);
  const outOfOrder = versions
    .map((version, i) => [headings[i + 1], version] as const)
    .filter(([, version], i) => i > 0 && !newer(versions[i - 1] ?? [], version))
    .map(([heading]) => heading);
  expect(outOfOrder).toEqual([]);
});

const tags = Bun.spawnSync(['git', 'tag', '--list', 'v*'], { cwd: join(import.meta.dir, '..') })
  .stdout.toString()
  .split('\n')
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));

// A checkout without tags (a shallow CI clone) has nothing to compare against.
test.skipIf(tags.length === 0)('every release tag has its own section', () => {
  const sections = new Set(headings.map((heading) => heading.match(/^\[([^\]]+)\]/)?.[1]));
  expect(tags.filter((tag) => !sections.has(tag.slice(1)))).toEqual([]);
});
