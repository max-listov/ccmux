#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { z } from 'zod';
import { invoke, output, refused } from './custom-tool-observation';
import { processState as sharedProcessState } from './process-state.ts';

// Optional explicit packed-consumer module for qualifying the upstream mount separately.
const mountSpecifier = process.argv[2] ?? 'stitchkit/tools';
const { mountAgent }: typeof import('stitchkit/tools') = await import(mountSpecifier);
const versionSchema = z.object({ version: z.string() });
const factoryVersion = versionSchema.parse(
  await Bun.file(new URL('../package.json', import.meta.resolve('stitchkit'))).json(),
).version;
const mountEntry =
  process.argv[2] === undefined
    ? import.meta.resolve('stitchkit/tools')
    : pathToFileURL(mountSpecifier);
const mountVersion = versionSchema.parse(
  await Bun.file(new URL('../package.json', mountEntry)).json(),
).version;
if (factoryVersion !== mountVersion) throw new Error('Qualification package versions differ');

/** Dependency qualification, not a managed-session/model E2E or a substitute tool implementation. */
const root = await mkdtemp(join(tmpdir(), 'ccmux-custom-tool-boundary-'));
const observations: { probe: string; passed: boolean; evidence: unknown }[] = [];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function record(probe: string, passed: boolean, evidence: unknown) {
  observations.push({ probe, passed, evidence });
}
const textRead = z.object({ text: z.string() });

async function fileBoundary() {
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'nested', 'source.txt'), 'original');
  await writeFile(join(outside, 'source.txt'), 'outside-fixture');
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({ root: workspace, authorize: () => true }),
  });
  const read = await invoke(tools, 'read_file', { path: 'nested/source.txt' });
  const readable = textRead.safeParse(output(read)).data?.text === 'original';
  record('regular-read', readable, { read });
  if (!readable) {
    record('file-races-qualified', false, { reason: 'positive-read-control-failed' });
    return;
  }
  const traversal = await invoke(tools, 'read_file', { path: '../outside/source.txt' });
  record('traversal-refused', refused(traversal), { traversal });
  const stale = await invoke(tools, 'edit_file', {
    path: 'nested/source.txt',
    expectedSha256: digest('not-original'),
    oldText: 'original',
    newText: 'changed',
    dryRun: false,
  });
  record('stale-digest-refused', refused(stale) && stale.code === 'CONFLICT', { stale });

  const entered = Promise.withResolvers<void>();
  const allow = Promise.withResolvers<void>();
  const delayed = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root: workspace,
      authorize: async () => {
        entered.resolve();
        await allow.promise;
        return true;
      },
    }),
  });
  const pending = invoke(delayed, 'read_file', { path: 'nested/source.txt' });
  await entered.promise;
  await rename(join(workspace, 'nested'), join(workspace, 'original-nested'));
  await symlink(outside, join(workspace, 'nested'));
  allow.resolve();
  const raced = await pending;
  record('parent-swap-read-refused', refused(raced), {
    escapedRead: textRead.safeParse(output(raced)).data?.text === 'outside-fixture',
    refused: refused(raced),
  });
}

async function patchBoundary() {
  const workspace = join(root, 'patch-workspace');
  const outside = join(root, 'patch-outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'nested', 'source.txt'), 'same-content');
  await writeFile(join(outside, 'source.txt'), 'same-content');
  const positive = await invoke(
    mountAgent([], {
      runtimeTools: createAgentCodingTools({ root: workspace, authorize: () => true }),
    }),
    'read_file',
    { path: 'nested/source.txt' },
  );
  if (textRead.safeParse(output(positive)).data?.text !== 'same-content') {
    record('patch-race-qualified', false, { reason: 'positive-read-control-failed', positive });
    return;
  }
  const entered = Promise.withResolvers<void>();
  const allow = Promise.withResolvers<void>();
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root: workspace,
      authorize: async () => {
        entered.resolve();
        await allow.promise;
        return true;
      },
    }),
  });
  const pending = invoke(tools, 'edit_file', {
    path: 'nested/source.txt',
    expectedSha256: digest('same-content'),
    oldText: 'same-content',
    newText: 'mutated',
    dryRun: false,
  });
  await entered.promise;
  await rename(join(workspace, 'nested'), join(workspace, 'original-nested'));
  await symlink(outside, join(workspace, 'nested'));
  allow.resolve();
  const result = await pending;
  const escapedWrite = (await readFile(join(outside, 'source.txt'), 'utf8')) !== 'same-content';
  record('parent-swap-patch-refused', refused(result) && !escapedWrite, {
    escapedWrite,
    refused: refused(result),
  });
}

async function cancellation() {
  const workspace = join(root, 'commands');
  await mkdir(workspace);
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root: workspace,
      authorize: () => true,
      executables: { runtime: process.execPath },
      environment: {},
      limits: { shellTimeoutMs: 3_000 },
    }),
  });
  const success = await invoke(tools, 'run_command', {
    executable: 'runtime',
    args: ['--no-env-file', '-e', 'console.log("fixture")'],
    cwd: '.',
  });
  const shell = z.object({ exitCode: z.number().nullable(), outcome: z.string() });
  record('command-success', shell.safeParse(output(success)).data?.exitCode === 0, { success });
  const nonzero = await invoke(tools, 'run_command', {
    executable: 'runtime',
    args: ['--no-env-file', '-e', 'process.exit(7)'],
    cwd: '.',
  });
  record('command-exit-code', shell.safeParse(output(nonzero)).data?.exitCode === 7, { nonzero });
  const abort = new AbortController();
  const started = join(workspace, 'started');
  const effect = join(workspace, 'effect');
  const descendant = `await Bun.write(${JSON.stringify(started)}, String(process.pid));
    setTimeout(async () => { await Bun.write(${JSON.stringify(effect)}, 'effect'); }, 500);
    setTimeout(() => process.exit(0), 800);`;
  const parent = `const child = Bun.spawn([process.execPath, '--no-env-file', '-e', ${JSON.stringify(descendant)}],
    {stdout:'inherit',stderr:'inherit',env:{}}); await child.exited;`;
  const pending = invoke(
    tools,
    'run_command',
    {
      executable: 'runtime',
      args: ['--no-env-file', '-e', parent],
      cwd: '.',
    },
    abort.signal,
  );
  const deadline = Date.now() + 2_000;
  while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(started))
    throw new Error('Descendant did not start; cancellation was not tested');
  const descendantPid = z.coerce
    .number()
    .int()
    .positive()
    .parse(await readFile(started, 'utf8'));
  const cancelledAt = performance.now();
  const processState = () => sharedProcessState(descendantPid);
  const beforeCancellation = processState();
  if (['absent', 'Z', 'X'].includes(beforeCancellation))
    throw new Error('Descendant was not executing before cancellation');
  abort.abort();
  const result = await pending;
  const elapsedMs = Math.round(performance.now() - cancelledAt);
  // A zombie has exited and cannot produce an effect; kill(pid, 0) alone mislabels it as running.
  const alive = () => !['absent', 'Z', 'X'].includes(processState());
  const childStateAtReturn = processState();
  const childAliveAtReturn = !['absent', 'Z', 'X'].includes(childStateAtReturn);
  // Closing pipes alone must not pass; retain the fixture until its finite child has exited.
  const cleanupDeadline = Date.now() + 1500;
  while (alive() && Date.now() < cleanupDeadline) await Bun.sleep(10);
  if (alive()) throw new Error('Self-terminating fixture descendant did not exit');
  record('cancelled-command-tree-stops', !existsSync(effect) && !childAliveAtReturn, {
    effectAfterCancellation: existsSync(effect),
    childAliveAtReturn,
    childStateAtReturn,
    beforeCancellation,
    elapsedMs,
    result,
  });
}

try {
  await fileBoundary();
  await patchBoundary();
  await cancellation();
  console.log(JSON.stringify({ dependency: `stitchkit@${factoryVersion}`, observations }, null, 2));
  if (observations.some(({ passed }) => !passed)) process.exitCode = 1;
} finally {
  // Every command descendant is self-terminating; no service or user session uses this fixture.
  await rm(root, { recursive: true, force: true });
}
