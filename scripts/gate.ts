#!/usr/bin/env bun
/**
 * The complete local gate: lint, the publication check, types, the test suite, the packed client.
 *
 * Two things make it the length of its slowest part rather than the sum of them. The steps do not
 * depend on each other, so they run at once; the tests run in several processes
 * (`test-shards.ts`). And a tree that has passed is not asked again: a green run on a clean
 * checkout leaves a receipt under the repository's git directory, named by the tree it checked, and
 * `--if-needed` — what the pre-push hook runs — passes at once for a tree that has one. A release
 * pushes its commit and then its tag: the same tree, gated once.
 *
 * The receipt is of a TREE, not of a commit or a branch, and is written only when the checkout was
 * clean when the run began and is the same tree when it ends — a change made while the gate ran was
 * not checked by it. It is local and untracked: CI runs the gate itself.
 *
 *   bun scripts/gate.ts                 run everything; leave a receipt when the tree is clean
 *   bun scripts/gate.ts --if-needed [SHA…]   pass when every named commit's tree (HEAD's when none
 *                                       is named) has a receipt and the checkout is clean; else run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const git = (...args: string[]): string | null => {
  const run = Bun.spawnSync(['git', '-C', ROOT, ...args], { stdout: 'pipe', stderr: 'ignore' });
  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
};
const receiptDir = (): string | null => {
  const dir = git('rev-parse', '--absolute-git-dir');
  return dir === null ? null : join(dir, 'ccmux-gate');
};
/** The tree of a commit, and only when the checkout holds nothing else: what a run would check. */
const cleanTree = (commit = 'HEAD'): string | null =>
  git('status', '--porcelain') === '' ? git('rev-parse', `${commit}^{tree}`) : null;

const args = process.argv.slice(2);
if (args[0] === '--if-needed') {
  const dir = receiptDir();
  const head = git('rev-parse', 'HEAD^{tree}');
  const trees = (args.length > 1 ? args.slice(1) : ['HEAD']).map((commit) =>
    git('rev-parse', `${commit}^{tree}`),
  );
  // Only what is checked out can be run, so only that can be vouched for: a pushed commit that is
  // not the checkout's tree is gated by running the gate on what is here, as before.
  const vouched =
    dir !== null &&
    cleanTree() !== null &&
    trees.every((tree) => tree !== null && tree === head && existsSync(join(dir, tree)));
  if (vouched) {
    const tree = head as string;
    console.log(
      `gate: tree ${tree.slice(0, 12)} already passed (${readFileSync(join(dir as string, tree), 'utf8').trim()})`,
    );
    process.exit(0);
  }
}

const before = cleanTree();
const started = performance.now();
const steps: [string, string[]][] = [
  ['lint', ['bunx', 'biome', 'check', '--error-on-warnings', '.']],
  ['publication', [process.execPath, 'scripts/check-publication.ts']],
  ['types', ['bunx', 'tsc', '--noEmit']],
  ['tests', [process.execPath, 'scripts/test-shards.ts']],
  ['packed client', [process.execPath, 'scripts/verify-control-service-client.ts']],
];
const results = await Promise.all(
  steps.map(async ([name, argv]) => {
    const began = performance.now();
    const child = Bun.spawn(argv, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      name,
      code,
      output: `${stdout}${stderr}`,
      seconds: (performance.now() - began) / 1000,
    };
  }),
);
for (const step of results) {
  console.log(
    `\n== ${step.name}: ${step.code === 0 ? 'ok' : 'FAILED'} in ${step.seconds.toFixed(1)}s`,
  );
  // A passing step is its last lines; a failing one is everything it said.
  console.log(
    step.code === 0 ? step.output.trimEnd().split('\n').slice(-6).join('\n') : step.output,
  );
}
const failed = results.filter((step) => step.code !== 0);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  console.error(`\ngate: FAILED in ${seconds}s — ${failed.map((step) => step.name).join(', ')}`);
  process.exit(1);
}
const dir = receiptDir();
const after = cleanTree();
if (dir !== null && before !== null && before === after) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, before), `${new Date().toISOString()} in ${seconds}s\n`);
  console.log(`\ngate: ok in ${seconds}s — receipt for tree ${before.slice(0, 12)}`);
} else console.log(`\ngate: ok in ${seconds}s — no receipt: the checkout is not a clean tree`);
