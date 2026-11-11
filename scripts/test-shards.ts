#!/usr/bin/env bun
/**
 * The test suite, dealt out to several `bun test` processes at once.
 *
 * One process runs the files one after another, and these tests mostly WAIT — on child processes,
 * sockets, tmux, timers. Measured on the whole suite: 333 s of wall clock for 148 s of CPU, under
 * half of one core on a machine with eighteen. Each test process already has a private ccmux home
 * (`test/preload.ts`), so files in different processes share nothing; run side by side the suite
 * takes about as long as its slowest share.
 *
 * Files are dealt by how long each took the last time (`.cache/test-timings.json`, written by every
 * run and not tracked), heaviest first onto the lightest share; a file never seen counts as average.
 * A share that fails prints its whole output; one that passes prints only its counts. The exit code
 * is non-zero when any share fails — and when the shares together ran fewer files than were dealt,
 * because a suite that silently ran less is the failure a green run would hide.
 *
 * A few files measure what several processes do to each other on one machine — two writers on one
 * database, a deadline of their own — and are themselves disturbed by seven other shares doing the
 * same next to them. They run after the shares, alone, in one process.
 *
 *   bun scripts/test-shards.ts [--shares N] [bun test flags…] [files…]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { sharesFor } from './testShares.ts';

const ROOT = resolve(import.meta.dir, '..');
/** Run alone, after everything else: each fails under the load of the other shares, not on its own. */
const ALONE = new Set(['test/usage-bounds.test.ts', 'test/context-controls.test.ts']);
const TIMINGS = join(ROOT, '.cache', 'test-timings.json');
const args = process.argv.slice(2);
const sharesAt = args.indexOf('--shares');
const asked = sharesAt === -1 ? undefined : Number(args.splice(sharesAt, 2)[1]);
const named = args.filter((arg) => !arg.startsWith('-'));
const flags = args.filter((arg) => arg.startsWith('-'));

const files =
  named.length > 0
    ? named
    : [...new Bun.Glob('test/**/*.test.{ts,tsx}').scanSync({ cwd: ROOT })].sort();
if (files.length === 0) {
  console.error('test-shards: no test files');
  process.exit(1);
}

let known: Record<string, number> = {};
try {
  known = JSON.parse(readFileSync(TIMINGS, 'utf8')) as Record<string, number>;
} catch {
  // First run, or a cache that was cleared: every file counts the same.
}
const seen = files.map((file) => known[file]).filter((ms): ms is number => typeof ms === 'number');
const average = seen.length === 0 ? 1 : seen.reduce((sum, ms) => sum + ms, 0) / seen.length;
/** What a file costs beyond its tests: loading the modules it imports, in a fresh registry. */
const PER_FILE_MS = 400;
const cost = (file: string): number => (known[file] ?? average) + PER_FILE_MS;

const wanted = asked ?? sharesFor(availableParallelism(), loadavg()[0] ?? 0);
const alone = files.filter((file) => ALONE.has(file));
const together = files.filter((file) => !ALONE.has(file));
const count = Math.max(1, Math.min(wanted, together.length));
const shares = Array.from({ length: count }, () => ({ files: [] as string[], ms: 0 }));
for (const file of [...together].sort((a, b) => cost(b) - cost(a))) {
  const lightest = shares.reduce((least, share) => (share.ms < least.ms ? share : least));
  lightest.files.push(file);
  lightest.ms += cost(file);
}

const started = performance.now();
const out = join(tmpdir(), `ccmux-test-shards-${process.pid}`);
mkdirSync(out, { recursive: true });
const runShare = async (share: { files: string[]; ms: number }, index: number) => {
  const junit = join(out, `${index}.xml`);
  const began = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      '--timeout',
      '20000',
      ...flags,
      '--reporter=junit',
      `--reporter-outfile=${junit}`,
      ...share.files,
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    index,
    share,
    code,
    output: `${stdout}${stderr}`,
    junit,
    ms: performance.now() - began,
  };
};
const results = await Promise.all(
  shares.filter((share) => share.files.length > 0).map((share, index) => runShare(share, index)),
);
if (alone.length > 0) results.push(await runShare({ files: alone, ms: 0 }, results.length));

const totals = { pass: 0, fail: 0, skip: 0, files: 0 };
const timings: Record<string, number> = { ...known };
for (const result of results) {
  const number = (word: string): number =>
    Number(new RegExp(`^\\s*(\\d+) ${word}$`, 'm').exec(result.output)?.[1] ?? 0);
  totals.pass += number('pass');
  totals.fail += number('fail');
  totals.skip += number('skip');
  totals.files += Number(/across (\d+) files?/.exec(result.output)?.[1] ?? 0);
  try {
    const perFile = new Map<string, number>();
    for (const test of readFileSync(result.junit, 'utf8').matchAll(/<testcase\b[^>]*>/g)) {
      const file = /\bfile="([^"]+)"/.exec(test[0])?.[1];
      const seconds = Number(/\btime="([\d.]+)"/.exec(test[0])?.[1] ?? 0);
      if (file === undefined) continue;
      const key = relative(ROOT, resolve(ROOT, file));
      perFile.set(key, (perFile.get(key) ?? 0) + seconds * 1000);
    }
    for (const [file, ms] of perFile) timings[file] = Math.round(ms);
  } catch {
    // A share that died before writing its report has no timings to keep.
  }
  const head = `share ${result.index + 1}/${results.length}: ${result.share.files.length} files, ${(result.ms / 1000).toFixed(1)}s, exit ${result.code}`;
  if (result.code === 0) console.log(head);
  else {
    console.log(`${head} — FAILED, its output follows`);
    console.log(result.output);
  }
}
try {
  mkdirSync(dirname(TIMINGS), { recursive: true });
  writeFileSync(TIMINGS, `${JSON.stringify(timings)}\n`);
} catch {
  // The timings only make the next deal more even.
}

const failed = results.some((result) => result.code !== 0);
const missing = totals.files !== files.length;
console.log(`\n ${totals.pass} pass\n ${totals.skip} skip\n ${totals.fail} fail`);
console.log(
  `Ran ${totals.pass + totals.fail + totals.skip} tests across ${totals.files} files in ${results.length} shares. [${((performance.now() - started) / 1000).toFixed(2)}s]`,
);
if (missing)
  console.error(
    `test-shards: ${files.length} files were dealt and ${totals.files} ran — a share ended before its files did`,
  );
process.exit(failed || missing ? 1 : 0);
