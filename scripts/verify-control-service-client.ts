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
    `import { controlContract, createInjectedControlClient, type UsageSummary } from '@ccmux/control-service-client';
const aggregate: UsageSummary['self'] = {
  values:{inputTokens:10,outputTokens:5,cacheReadTokens:null,cacheCreationTokens:null,reasoningTokens:null,totalTokens:null},
  measured:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheCreationTokens:0,reasoningTokens:0,totalTokens:0},
  fieldCoverage:{inputTokens:'full',outputTokens:'full',cacheReadTokens:'unknown',cacheCreationTokens:'unknown',reasoningTokens:'unknown',totalTokens:'unknown'},
  observations:1,coverage:'full',costs:[]
};
const summary: UsageSummary = {address:'host-a:agent-a',runtime:'claude',identity:{sessionId:null,nativeSessionId:null},additivity:'session-only',
  source:'readable',state:'ready',reason:null,revision:'1',observedAt:null,sourceEventRange:{first:null,last:null},indexedBytes:100,sourceBytes:100,
  malformedRecords:0,history:'native-history',self:aggregate,unattributed:aggregate,
  delegated:{coverage:'unknown',addresses:[]},reportedPipeline:null,buckets:[],timezone:'UTC',nextCursor:null,reset:false};
const client = createInjectedControlClient(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === '/control/usage') return Response.json(summary);
  if (url.pathname !== '/control/directories') throw new Error('canonical route lost');
  const body = JSON.parse(String(init?.body));
  return Response.json({path:body.path,parent:null,entries:[],nextCursor:null});
});
if (!controlContract.endpoints['directory.list']) throw new Error('canonical contract missing');
const result = await client['directory.list']({path:'/tmp'});
if (result.path !== '/tmp' || result.entries.length !== 0) throw new Error('typed client failed');
if (!controlContract.endpoints['usage.read'] || !controlContract.endpoints['usage.list']) throw new Error('usage contract missing');
const usage = await client['usage.read']({address:'host-a:agent-a'});
if (usage.self.values.inputTokens !== 10 || usage.self.values.outputTokens !== 5) throw new Error('typed usage lost');
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
