#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packageControlServiceClient } from './package-control-service.ts';

const directory = mkdtempSync('/tmp/ccmux-packed-service-');
const packageDir = join(directory, 'package');
const consumer = join(directory, 'consumer');

function run(command: string, args: string[]): boolean {
  const result = Bun.spawnSync([command, ...args], {
    cwd: consumer,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  return result.exitCode === 0;
}

try {
  const suppliedArtifact = process.env.CCMUX_PACKED_CLIENT_ARTIFACT;
  const packed =
    suppliedArtifact === undefined
      ? await packageControlServiceClient(packageDir)
      : { artifact: resolve(suppliedArtifact) };
  mkdirSync(consumer, { recursive: true });
  await Bun.write(
    join(consumer, 'package.json'),
    `${JSON.stringify({
      name: 'ccmux-packed-client-gate',
      private: true,
      type: 'module',
      dependencies: { '@ccmux/control-service-client': `file:${resolve(packed.artifact)}` },
      devDependencies: { typescript: '7.0.2' },
    })}\n`,
  );
  await Bun.write(
    join(consumer, 'check.ts'),
    `import { controlContract, createInjectedControlClient } from '@ccmux/control-service-client';
const client = createInjectedControlClient(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname !== '/control/directories') throw new Error('canonical route lost');
  const body = JSON.parse(String(init?.body));
  return Response.json({path:body.path,parent:null,entries:[],nextCursor:null});
});
if (!controlContract.endpoints['directory.list']) throw new Error('canonical contract missing');
const result = await client['directory.list']({path:'/tmp'});
if (result.path !== '/tmp' || result.entries.length !== 0) throw new Error('typed client failed');
`,
  );
  if (!run('bun', ['install', '--ignore-scripts'])) throw new Error('consumer install failed');
  if (
    !run('bun', [
      'x',
      'tsc',
      '--noEmit',
      '--strict',
      '--moduleResolution',
      'bundler',
      '--module',
      'esnext',
      '--target',
      'es2022',
      'check.ts',
    ])
  )
    throw new Error('consumer typecheck failed');
  if (!run('bun', ['check.ts'])) throw new Error('consumer runtime failed');
  console.log(JSON.stringify({ artifact: packed.artifact, status: 'ok' }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
