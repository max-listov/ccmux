#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import compiler from 'typescript/package.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };
import { VERSION } from '../src/util/version.ts';
import { serveClientCandidate } from './client-consumer-registry.ts';
import { CLIENT_NAME, inspectClientArchive, NPM_REGISTRY } from './control-client-archive.ts';
import { packageControlServiceClient } from './package-control-service.ts';

const directory = mkdtempSync('/tmp/ccmux-packed-service-');
const packageDir = join(directory, 'package');
const consumer = join(directory, 'consumer');

async function run(command: string, args: string[]): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd: consumer,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(directory, 'cache') },
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`Installed consumer: ${command} ${args.join(' ')} exited ${code}`);
}

let candidate: ReturnType<typeof serveClientCandidate> | undefined;
try {
  const args = Bun.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--from-npm'))
    throw new Error('Usage: verify-control-service-client.ts [--from-npm]');
  if (!args.length) {
    const path =
      process.env.CCMUX_PACKED_CLIENT_ARTIFACT ??
      (await packageControlServiceClient(packageDir)).artifact;
    candidate = serveClientCandidate(await inspectClientArchive(resolve(path), VERSION));
  }
  mkdirSync(consumer, { recursive: true });
  await Bun.write(
    join(consumer, '.npmrc'),
    `registry=${NPM_REGISTRY}/\n@ccmux:registry=${candidate?.url.origin ?? NPM_REGISTRY}/\n`,
  );
  await Bun.write(
    join(consumer, 'package.json'),
    `${JSON.stringify({
      name: 'ccmux-packed-client-gate',
      private: true,
      type: 'module',
      dependencies: {
        [CLIENT_NAME]: VERSION,
        stitchkit: manifest.devDependencies.stitchkit,
        '@stitchwire/client': manifest.dependencies['@stitchwire/client'],
      },
      devDependencies: { typescript: compiler.version },
    })}\n`,
  );
  await Bun.write(
    join(consumer, 'check.ts'),
    `import { controlContract, controlServiceEffects, createInjectedControlClient, type OperationEffect, type UsageSummary } from '@ccmux/control-service-client';
import packageManifest from '@ccmux/control-service-client/package.json' with { type: 'json' };
import { createControlClient, createExternalStatusEncoder, currentExternalStatus, ExternalStatusSnapshotSchema, FleetAnswerSchema, LogPayloadSchema } from '@ccmux/control-service-client/control-client';
const offline = ExternalStatusSnapshotSchema.parse({
  protocol: 1, version: '1.0.0', machine: 'consumer', generation: '33333333-3333-4333-8333-333333333333', sequence: 0,
  source: 'codex-app-server', status: 'unavailable', reason: 'endpoint-absent', observedAt: null,
  expiresAt: null, truncated: false, omitted: 0, sessions: []
});
if (currentExternalStatus(offline).reason !== 'endpoint-absent' || createExternalStatusEncoder()(offline).frame !== 'snapshot')
  throw new Error('resident status contract failed');
if (FleetAnswerSchema.safeParse({}).success || LogPayloadSchema.safeParse({rows: 'invalid'}).success)
  throw new Error('resident schema accepted an invalid payload');
const resident = createControlClient({socket: '/unused-consumer-test.sock'});
const readStatus: () => Promise<typeof offline> = resident['external.list'];
if (typeof readStatus !== 'function') throw new Error('typed resident operation missing');
await resident.close();
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
// @ts-expect-error An unknown operation effect must be rejected by the published types.
const invalidEffect: OperationEffect = 'not-a-control-effect';
if (packageManifest.version !== ${JSON.stringify(VERSION)}) throw new Error('package version not readable');
`,
  );
  await run('bun', ['install', '--ignore-scripts']);
  if (candidate && candidate.downloads() === 0)
    throw new Error('Client archive was not downloaded');
  for (const [resolution, module] of [
    ['Bundler', 'ESNext'],
    ['NodeNext', 'NodeNext'],
  ] as const) {
    await run(join(consumer, 'node_modules/.bin/tsc'), [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--moduleResolution',
      resolution,
      '--module',
      module,
      '--target',
      'es2022',
      '--resolveJsonModule',
      'check.ts',
    ]);
  }
  await run('bun', ['check.ts']);
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
  await run('bun', ['wire.ts']);
  const copies = [...new Bun.Glob('**/node_modules/stitchkit/package.json').scanSync(consumer)];
  if (copies.length !== 1)
    throw new Error(
      `consumer holds ${copies.length} physical stitchkit copies: ${copies.join(', ')}`,
    );
  console.log(
    JSON.stringify({
      package: CLIENT_NAME,
      version: VERSION,
      registry: candidate ? 'candidate' : NPM_REGISTRY,
      typechecks: ['Bundler', 'NodeNext'],
      status: 'ok',
    }),
  );
} finally {
  if (candidate) await candidate.close();
  rmSync(directory, { recursive: true, force: true });
}
