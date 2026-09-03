#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { invoke, output } from './custom-tool-observation.ts';

const packageDirectory = process.argv[2];
if (!packageDirectory) throw new Error('Pass the installed Stitchkit package directory');
const entry = (name: string) => pathToFileURL(join(packageDirectory, 'dist', name)).href;
const { createAgentCodingTools }: typeof import('stitchkit/agent-runtime/coding-tools') =
  await import(entry('agent-runtime-coding-tools.js'));
const { createAgentHarnessFileResources }: typeof import('stitchkit/agent-runtime/harness') =
  await import(entry('agent-runtime-harness.js'));
const { mountAgent }: typeof import('stitchkit/tools') = await import(entry('tools.js'));
const version = z
  .object({ version: z.string() })
  .parse(JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))).version;
const root = await mkdtemp(join(tmpdir(), 'ccmux-file-platform-'));
const observations: { probe: string; passed: boolean; evidence: unknown }[] = [];
const diagnostics: { probe: string; supported: boolean; evidence: unknown }[] = [];
function record(probe: string, passed: boolean, evidence: unknown) {
  observations.push({ probe, passed, evidence });
}
const ErrorCodeSchema = z.object({ code: z.string() });
const text = 'fixture-content';

try {
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'file.txt'), text);
  await writeFile(join(root, 'nested', 'file.txt'), text);
  const direct = await readFile(join(root, 'nested', 'file.txt'), 'utf8');
  record('ordinary-fs-read', direct === text, { correctContent: direct === text });
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const descriptor = `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${handle.fd}`;
    // Descriptor path emulation is diagnostic only: Darwin uses native openat handles.
    const sameRoot = await realpath(descriptor)
      .then(async (resolved) => resolved === (await realpath(root)))
      .catch(() => false);
    diagnostics.push({ probe: 'descriptor-realpath', supported: sameRoot, evidence: { sameRoot } });
    try {
      const descriptorText = await readFile(join(descriptor, 'nested', 'file.txt'), 'utf8');
      diagnostics.push({
        probe: 'descriptor-child-read',
        supported: descriptorText === text,
        evidence: { readable: true },
      });
    } catch (error) {
      diagnostics.push({
        probe: 'descriptor-child-read',
        supported: false,
        evidence: { code: ErrorCodeSchema.safeParse(error).data?.code },
      });
    }
  } finally {
    await handle.close();
  }

  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
  });
  const TextSchema = z.object({ text: z.string() });
  for (const path of ['file.txt', 'nested/file.txt']) {
    const result = await invoke(tools, 'read_file', { path });
    record(`read:${path}`, TextSchema.safeParse(output(result)).data?.text === text, result);
  }
  const write = await invoke(tools, 'write_file', {
    path: 'created.txt',
    content: 'created',
    overwrite: false,
  });
  const written = await readFile(join(root, 'created.txt'), 'utf8').catch(() => undefined);
  record('write_file', write.kind === 'returned' && written === 'created', write);
  const patch = await invoke(tools, 'edit_file', {
    path: 'file.txt',
    expectedSha256: createHash('sha256').update(text).digest('hex'),
    oldText: text,
    newText: 'patched',
    dryRun: false,
  });
  record(
    'edit_file',
    patch.kind === 'returned' && (await readFile(join(root, 'file.txt'), 'utf8')) === 'patched',
    patch,
  );
  const search = await invoke(tools, 'search_files', { query: 'file', mode: 'path' });
  const matches = z.object({ matches: z.array(z.unknown()) }).safeParse(output(search));
  record(
    'search_files',
    search.kind === 'returned' && (matches.data?.matches.length ?? 0) > 0,
    search,
  );
  try {
    const resources = await createAgentHarnessFileResources({
      roots: [{ id: 'fixture', path: root, kind: 'instruction' }],
    }).load();
    record('file-resources', resources.resources.length > 0, { count: resources.resources.length });
  } catch (error) {
    record('file-resources', false, { code: ErrorCodeSchema.safeParse(error).data?.code });
  }
  console.log(
    JSON.stringify(
      {
        dependency: `stitchkit@${version}`,
        platform: process.platform,
        node: process.versions.node,
        bun: process.versions.bun,
        observations,
        diagnostics,
      },
      null,
      2,
    ),
  );
  if (observations.some(({ passed }) => !passed)) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
