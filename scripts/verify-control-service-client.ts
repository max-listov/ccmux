#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import manifest from '../package.json' with { type: 'json' };
import { VERSION } from '../src/util/version.ts';
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
      dependencies: {
        '@ccmux/control-service-client': `file:${resolve(packed.artifact)}`,
        stitchkit: manifest.devDependencies.stitchkit,
        '@stitchwire/client': manifest.dependencies['@stitchwire/client'],
      },
      devDependencies: { typescript: '7.0.2' },
    })}\n`,
  );
  await Bun.write(
    join(consumer, 'check.ts'),
    `import { controlContract, controlServiceEffects, createInjectedControlClient, type OperationEffect, type UsageSummary } from '@ccmux/control-service-client';
import { version as packageVersion } from '@ccmux/control-service-client/package.json';
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
let retryProbeCalls = 0;
const failingClient = createInjectedControlClient(async () => {
  retryProbeCalls += 1;
  throw new Error('simulated wire timeout');
}, 5_000);
let failed = false;
try { await failingClient['directory.list']({}); } catch { failed = true; }
if (!failed || retryProbeCalls !== 1) throw new Error(\`injected client retried: \${retryProbeCalls}\`);
if (!controlContract.endpoints['usage.read'] || !controlContract.endpoints['usage.list']) throw new Error('usage contract missing');
const usage = await client['usage.read']({address:'host-a:agent-a'});
if (usage.self.values.inputTokens !== 10 || usage.self.values.outputTokens !== 5) throw new Error('typed usage lost');
// The declared service as a transport projects it: every operation, its effect, the version.
if (Object.keys(controlServiceEffects).length !== Object.keys(controlContract.endpoints).length) throw new Error('effects incomplete');
const stop: OperationEffect = controlServiceEffects['session.stop'];
if (stop !== 'write' || controlServiceEffects['fleet.list'] !== 'read') throw new Error('service effects lost');
if (packageVersion !== ${JSON.stringify(VERSION)}) throw new Error('package version not readable');
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
      '--resolveJsonModule',
      'check.ts',
    ])
  )
    throw new Error('consumer typecheck failed');
  if (!run('bun', ['check.ts'])) throw new Error('consumer runtime failed');
  await Bun.write(
    join(consumer, 'wire.ts'),
    `
import assert from 'node:assert/strict';
import { controlContract } from '@ccmux/control-service-client';
import { serviceDescriptorFromContract } from '@stitchwire/client';
import { SERVICE_MAX_RESPONSE_BYTES } from '@stitchwire/client/contracts';
import { version } from '@ccmux/control-service-client/package.json';
const endpoints = Object.entries(controlContract.endpoints);
const settings = {
  service: 'ccmux.control', revision: version, maxInflight: 8,
  responseBytes: Object.fromEntries(endpoints.map(([id]) => [id, SERVICE_MAX_RESPONSE_BYTES])),
};
const descriptor = serviceDescriptorFromContract(controlContract, settings);
assert.deepEqual(
  Object.fromEntries(descriptor.operations.map(op => [op.id, op.effect])),
  Object.fromEntries(endpoints.map(([id, op]) => [id, op.effect])),
);
const invalid = {
  ...controlContract,
  endpoints: {
    ...controlContract.endpoints,
    'session.wake': {...controlContract.endpoints['session.wake'], timeout: 60000},
  },
};
assert.throws(
  () => serviceDescriptorFromContract(invalid, settings),
  error => error.issues?.some(issue => issue.path.at(-1) === 'timeoutMs'),
);
`,
  );
  if (!run('bun', ['wire.ts'])) throw new Error('packed Wire descriptor failed');
  const copies = [...new Bun.Glob('**/node_modules/stitchkit/package.json').scanSync(consumer)];
  if (copies.length !== 1)
    throw new Error(
      `consumer holds ${copies.length} physical stitchkit copies: ${copies.join(', ')}`,
    );
  console.log(JSON.stringify({ artifact: packed.artifact, status: 'ok' }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
